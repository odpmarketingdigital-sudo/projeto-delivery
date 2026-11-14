"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCart, type CartDeliveryAddress } from "@/context/CartContext";
import type { StorefrontMenu } from "@/lib/types";
import { halfHalfFlavorsLabel, withHalfHalfLabel } from "@/lib/halfHalf";
import { describeNextOpening, isStoreOpen } from "@/lib/openingHours";
import { formatCep, formatTravelDuration, parseCep, type DeliveryQuote } from "@/lib/delivery";
import {
  buildCatalogWhatsAppUrl,
  isCartItemPriceOnRequest,
  isDirectWhatsAppCheckoutEnabled,
} from "@/lib/catalogOrder";
import {
  formatEstimatedDeliveryWindowLabel,
  normalizeEstimatedDeliveryWindow,
  parseEstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";
import {
  computeCouponDiscount,
  couponDiscountLabel,
  normalizeCouponCode,
  normalizeCouponPhone,
  type AppliedCoupon,
} from "@/lib/coupons";
import {
  describeMinOrderShortfall,
  minOrderShortfall,
  normalizeMinOrderValue,
} from "@/lib/minOrder";
import {
  MEAL_VOUCHER_PAYMENT_METHOD,
  normalizeMealVouchers,
} from "@/lib/mealVouchers";
import {
  getCustomerProfile,
  readSavedCustomerPhone,
  saveCustomerProfile,
} from "@/lib/storage";
import {
  clearPendingOrderWhatsAppUrl,
  savePendingOrderWhatsAppUrl,
} from "@/lib/whatsappOrder";
import { WhatsAppSendHint } from "@/app/components/WhatsAppSendHint";
import { AddressAutocomplete } from "@/app/components/AddressAutocomplete";
import { useIsMounted } from "@/app/components/useIsMounted";
import {
  PixPaymentDialog,
  type PixPaymentDialogStatus,
} from "@/app/components/PixPaymentDialog";
import { isValidCpfCnpj } from "@/lib/billing";
import {
  isGooglePlacesEnabled,
  type GooglePlaceAddress,
} from "@/lib/googleMapsPlaces";

type PaymentMethod =
  | "pix"
  | "cartao"
  | "dinheiro"
  | "pix_online"
  | "vale_refeicao";

/** Estado da cobrança PIX Online exibida no checkout. */
interface PixCheckoutState {
  orderId: string;
  total: number;
  status: PixPaymentDialogStatus;
  payload: string | null;
  /** QR Code PNG em base64 (sem prefixo `data:`). */
  encodedImage: string | null;
  error: string | null;
  /** Validade do QR Code em ISO (null = sem validade informada). */
  expiresAt: string | null;
  /** Rótulo da taxa retida pela plataforma (transparência). */
  platformFeeLabel: string;
}

interface DeliveryForm {
  nome: string;
  telefone: string;
  /** CPF/CNPJ do pagador — obrigatório no PIX Online (Asaas). */
  documento: string;
  cep: string;
  rua: string;
  numero: string;
  bairro: string;
  cidade: string;
  complemento: string;
  referencia: string;
}

type FormErrors = Partial<Record<keyof DeliveryForm | "pagamento", string>>;

/**
 * Resposta de `POST /api/delivery-quote`: cotação + endereço resolvido.
 * O servidor é a fonte da verdade — `POST /api/orders` recalcula a taxa.
 */
interface DeliveryQuotePreview extends DeliveryQuote {
  cep: string | null;
  address: {
    street: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
  } | null;
  warnings: string[];
}

/** Cotação vinculada à chave loja+endereço que a originou. */
interface DeliveryQuoteState {
  key: string;
  quote: DeliveryQuotePreview | null;
  error: string | null;
  loading: boolean;
}

interface DeliveryQuoteResponse {
  error?: string;
  /** Distância também exposta na raiz da resposta (float ou `null`). */
  distance_km?: number | null;
  /** Tempo de percurso em minutos (Google Routes) ou `null`. */
  duration_minutes?: number | null;
  /** `google_routes` (rota real) ou `haversine` (linha reta). */
  distance_source?: DeliveryQuote["distance_source"];
  quote?: DeliveryQuotePreview;
}

/**
 * Indica se as coordenadas guardadas ainda descrevem o endereço do formulário.
 *
 * Aceita duas formas: campos iguais aos da seleção ou o campo "Rua" contendo o
 * endereço completo que o widget do Google escreve ao confirmar a sugestão
 * (nesse caso o cliente não trocou nada — apenas o texto do campo difere).
 */
function deliveryPointMatchesForm(
  point: DeliveryPoint,
  form: { rua: string; numero: string }
): boolean {
  if (point.signature === addressSignature({ street: form.rua, number: form.numero })) {
    return true;
  }
  if (!point.formattedAddress) return false;

  return (
    addressSignature({
      street: point.formattedAddress,
      number: form.numero,
    }) === point.signature
  );
}

/**
 * Coordenadas do endereço de entrega (Google Places ou endereço salvo).
 *
 * `cep` é apenas informativo: quando existe, precisa conferir com o CEP do
 * formulário para o ponto valer. Sem CEP (o cliente não digita mais o campo) o
 * ponto continua sendo a fonte mais precisa para o cálculo da rota.
 */
interface DeliveryPoint {
  cep: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  /** Endereço formatado devolvido pelo Google (feedback visual da seleção). */
  formattedAddress: string | null;
  /**
   * Assinatura dos campos do endereço no momento da seleção
   * (`rua|numero|bairro|cidade`). O ponto só vale enquanto o formulário
   * continuar igual: editar qualquer campo invalida a seleção sem depender de
   * limpar estado em eventos do widget (que também disparam em seleções).
   */
  signature: string;
}

/** Campo do endereço normalizado para comparar seleção × formulário. */
function normalizeAddressField(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

/**
 * Assinatura estável do endereço (rua + número).
 *
 * Usada para saber se as coordenadas guardadas pertencem ao endereço que está no
 * formulário agora — sem isso, a taxa poderia ser calculada para um endereço que
 * o cliente já trocou. Bairro/cidade ficam de fora: são rótulos preenchidos pelo
 * Google/CEP e não mudam o ponto exato da entrega.
 */
function addressSignature(parts: {
  street: string;
  number: string;
}): string {
  return [parts.street, parts.number].map(normalizeAddressField).join("|");
}

/** Resultado da consulta de CEP vinculado ao CEP consultado. */
interface CepLookupState {
  cep: string;
  error: string | null;
  loading: boolean;
}

const INITIAL_FORM: DeliveryForm = {
  nome: "",
  telefone: "",
  documento: "",
  cep: "",
  rua: "",
  numero: "",
  bairro: "",
  cidade: "",
  complemento: "",
  referencia: "",
};

/**
 * Normaliza coordenadas salvas no navegador (endereço da sacola ou perfil do
 * cliente) para o formato usado na cotação. Retorna `null` sem coordenadas
 * válidas — nesse caso o servidor tenta o geocode exato do endereço digitado.
 */
function toDeliveryPoint(
  source:
    | Pick<
        CartDeliveryAddress,
        | "cep"
        | "latitude"
        | "longitude"
        | "placeId"
        | "formattedAddress"
        | "street"
        | "number"
        | "neighborhood"
        | "city"
      >
    | null
    | undefined
): DeliveryPoint | null {
  if (!source || source.latitude == null || source.longitude == null) {
    return null;
  }
  return {
    cep: parseCep(source.cep ?? "") ?? "",
    latitude: source.latitude,
    longitude: source.longitude,
    placeId: source.placeId ?? null,
    formattedAddress: source.formattedAddress?.trim() || null,
    signature: addressSignature({
      street: source.street ?? "",
      number: source.number ?? "",
    }),
  };
}

const PAYMENT_OPTIONS: { value: PaymentMethod; label: string; hint: string }[] =
  [
    { value: "pix", label: "Pix", hint: "Aprovação na hora" },
    { value: "cartao", label: "Cartão na Entrega", hint: "Crédito ou débito" },
    { value: "dinheiro", label: "Dinheiro", hint: "Pague ao entregador" },
  ];

/**
 * PIX Online (Split Asaas) — exibido apenas quando a loja conectou a subconta
 * e ligou "Aceitar PIX Online" no painel (`StorefrontInfo.accept_pix_online`
 * já chega efetivo de `/api/menu`). O cliente paga pelo app do banco e a
 * confirmação chega automaticamente pelo webhook.
 */
const PIX_ONLINE_OPTION: {
  value: PaymentMethod;
  label: string;
  hint: string;
} = {
  value: "pix_online",
  label: "PIX Online",
  hint: "Pague agora pelo app do banco",
};

/**
 * Vale-Refeição / Alimentação NA ENTREGA (maquininha presencial).
 *
 * Só entra na lista quando a loja cadastrou ao menos uma bandeira em
 * `establishments.accepted_meal_vouchers` (migração 20261111000004). Nada é
 * cobrado online: o entregador leva a maquininha e passa o cartão do cliente.
 */
const MEAL_VOUCHER_OPTION: {
  value: PaymentMethod;
  label: string;
  hint: string;
} = {
  value: MEAL_VOUCHER_PAYMENT_METHOD,
  label: "Vale-Refeição / Alimentação",
  hint: "Pague na entrega com o cartão de vale",
};

const formatBRL = (value: number) =>
  `R$ ${value.toFixed(2).replace(".", ",")}`;

const formatKm = (value: number) => value.toFixed(1).replace(".", ",");

/**
 * Rótulo padrão da previsão de entrega ("30 a 50 min").
 *
 * Usado enquanto a loja ainda não carregou ou quando a API devolve os campos
 * de tempo vazios/nulos, garantindo que o banner do checkout nunca fique
 * oculto nem sem valor.
 */
const DEFAULT_ESTIMATED_DELIVERY_LABEL = formatEstimatedDeliveryWindowLabel(
  normalizeEstimatedDeliveryWindow(null)
);

// Regex de UUID para validação do establishment_id.
// Aceita formato padrao xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (case-insensitive).
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidUUID(value: string): boolean {
  if (UUID_REGEX.test(value)) return true;
  const parts = value.split("-");
  if (parts.length !== 5) return false;
  const [a, b, c, d, e] = parts;
  const hex = /^[0-9a-fA-F]+$/;
  return (
    a.length === 8 &&
    b.length === 4 &&
    c.length === 4 &&
    d.length === 4 &&
    e.length === 12 &&
    hex.test(a) &&
    hex.test(b) &&
    hex.test(c) &&
    hex.test(d) &&
    hex.test(e)
  );
}

export function CheckoutForm({ slug }: { slug?: string }) {
  const router = useRouter();
  const {
    items,
    itemCount,
    total,
    clearCart,
    removeLine,
    setLineQuantity,
    isHydrated,
    deliveryCep,
    setDeliveryCep,
    deliveryAddress,
    setDeliveryAddress,
    orderType,
    setOrderType,
  } = useCart();

  /**
   * Modalidade de atendimento escolhida na sacola (ou aqui no checkout).
   * Retirada no balcão dispensa endereço e zera a taxa de entrega; a escolha é
   * persistida pelo `CartContext` e enviada em `order_type` para a API.
   */
  const isPickup = orderType === "retirada";

  const [form, setForm] = useState<DeliveryForm>(() => {
    // Pré-preenchimento com os dados salvos na sessão do navegador:
    //  - perfil do cliente (último pedido): nome, telefone e endereço;
    //  - endereço usado na sacola para calcular o frete (prioridade).
    // O cliente só revisa/ajusta o que quiser.
    //
    // Seguro contra divergência de hidratação: o formulário só é renderizado
    // quando `isHydrated` é true, e durante a hidratação `getCustomerProfile`
    // retorna os dados apenas no cliente (no servidor, `window` é undefined).
    const saved = getCustomerProfile();
    // Telefone também pode ter sido salvo pela tela de acompanhamento de
    // pedidos (`/[slug]/pedidos`) — bom fallback para quem ainda não finalizou
    // um pedido neste navegador.
    const savedPhone = saved?.phone?.trim() || readSavedCustomerPhone();
    const preferredCep =
      deliveryAddress?.cep || deliveryCep || saved?.cep || "";
    const formattedCep = preferredCep ? formatCep(preferredCep) : "";
    const base: DeliveryForm = saved
      ? {
          nome: saved.name,
          telefone: savedPhone,
          documento: "",
          cep: formattedCep,
          rua: saved.street,
          numero: saved.number,
          bairro: saved.neighborhood,
          cidade: saved.city ?? "",
          complemento: saved.complement ?? "",
          referencia: "",
        }
      : { ...INITIAL_FORM, cep: formattedCep, telefone: savedPhone };

    if (!deliveryAddress) return base;

    // O endereço cotado na sacola é o que o cliente acabou de confirmar:
    // prevalece sobre o endereço do perfil.
    return {
      ...base,
      cep: deliveryAddress.cep ? formatCep(deliveryAddress.cep) : base.cep,
      rua: deliveryAddress.street || base.rua,
      numero: deliveryAddress.number || base.numero,
      bairro: deliveryAddress.neighborhood || base.bairro,
      cidade: deliveryAddress.city || base.cidade,
      complemento: deliveryAddress.complement ?? base.complemento,
    };
  });

  // O contexto do carrinho pode hidratar depois deste componente (localStorage).
  // Quando isso acontece, leva o endereço usado no frete para o formulário uma
  // única vez — sem sobrescrever nada que o cliente já tenha preenchido.
  const [syncedCartAddress, setSyncedCartAddress] = useState(deliveryAddress);
  if (deliveryAddress !== syncedCartAddress) {
    setSyncedCartAddress(deliveryAddress);
    if (deliveryAddress) {
      setForm((prev) => ({
        ...prev,
        cep:
          prev.cep ||
          (deliveryAddress.cep ? formatCep(deliveryAddress.cep) : ""),
        rua: prev.rua || deliveryAddress.street,
        numero: prev.numero || deliveryAddress.number,
        bairro: prev.bairro || deliveryAddress.neighborhood,
        cidade: prev.cidade || deliveryAddress.city || "",
        complemento: prev.complemento || deliveryAddress.complement || "",
      }));
    }
  }
  const [errors, setErrors] = useState<FormErrors>({});
  const [payment, setPayment] = useState<PaymentMethod | "">("");
  const [troco, setTroco] = useState("");
  // Bandeira do vale-refeição/alimentação escolhida (só em `vale_refeicao`).
  const [mealVoucher, setMealVoucher] = useState("");
  // PIX Online (Split Asaas): cobrança em exibição e ciclo de confirmação.
  const [pixPayment, setPixPayment] = useState<PixCheckoutState | null>(null);
  const [pixCopied, setPixCopied] = useState(false);
  // Relógio do cronômetro do QR Code (atualiza 1x por segundo enquanto espera).
  const [pixNow, setPixNow] = useState(() => Date.now());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Cupom de desconto: código digitado, cupom validado na API e feedback.
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(
    null
  );
  const [couponError, setCouponError] = useState<string | null>(null);
  const [isApplyingCoupon, setIsApplyingCoupon] = useState(false);
  /** Telefone usado na última validação bem-sucedida (revalidação do 1º pedido). */
  const [appliedCouponPhone, setAppliedCouponPhone] = useState("");
  // Resumo congelado no momento da confirmação (o carrinho é limpo em seguida).
  const [confirmedSummary, setConfirmedSummary] = useState<{
    total: number;
    establishmentName: string;
    estimatedDeliveryTime: string | null;
    /** Link `wa.me` com o resumo do pedido (null quando o envio está off). */
    whatsappUrl: string | null;
  } | null>(null);
  // Nome do cliente reconhecido (perfil salvo) para o banner "Bem-vindo de volta".
  // Lido uma única vez na montagem; não muda durante a sessão do checkout.
  const [recognizedName] = useState<string | null>(
    () => getCustomerProfile()?.name ?? null
  );
  // Flag de montagem (hidratação): o checkout é renderizado no SERVIDOR, que
  // não tem `localStorage` nem o relógio do navegador. `isMounted` garante que
  // nada derivado dessas duas fontes apareça no primeiro render do cliente —
  // servidor e cliente emitem exatamente o mesmo HTML e só depois a página
  // troca para os dados reais.
  const isMounted = useIsMounted();
  // Relógio local para o status aberto/fechado (atualiza a cada minuto).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // Rastreia se já houve itens para só redirecionar quando o carrinho ESVAZIAR.
  const hadItems = useRef(false);
  // PIX Online: depois que o carrinho é limpo a tela de pagamento assume — este
  // ref impede o redirecionamento automático para o cardápio enquanto o fluxo
  // de pagamento/acompanhamento está ativo.
  const pixFlowDone = useRef(false);

  // ---- Dados da loja (taxa de entrega + WhatsApp) -------------------------
  // Com slug (rota /[slug]/checkout), a loja é resolvida pelo slug — fonte de
  // verdade da URL — e o carrinho é filtrado para itens dessa loja. Sem slug
  // (rota legada /checkout), cai no comportamento anterior (snapshot do item).
  const establishmentIdFromCart = useMemo(
    () => items.find((item) => item.establishmentId)?.establishmentId ?? null,
    [items]
  );

  const [establishmentIdFromSlug, setEstablishmentIdFromSlug] = useState<
    string | null
  >(null);

  // Itens válidos para esta loja (com slug, só os da loja; sem slug, todos).
  const storeItems = useMemo(() => {
    if (!slug || !establishmentIdFromSlug) return items;
    return items.filter((item) => item.establishmentId === establishmentIdFromSlug);
  }, [items, slug, establishmentIdFromSlug]);

  const establishmentId = slug
    ? establishmentIdFromSlug
    : establishmentIdFromCart;

  const [establishment, setEstablishment] =
    useState<StorefrontMenu["establishment"] | null>(null);
  const [menuMetaError, setMenuMetaError] = useState<string | null>(null);

  // ---- PIX Online (Split Asaas) -------------------------------------------
  // `accept_pix_online` já vem "efetivo" de /api/menu (loja conectada + chave
  // ligada); sem isso a opção nem aparece no checkout.
  const pixOnlineAvailable = establishment?.accept_pix_online === true;

  // ---- Vale-Refeição / Alimentação na entrega -----------------------------
  // `accepted_meal_vouchers` já chega normalizado de `/api/menu`. Sem nenhuma
  // bandeira cadastrada a opção nem aparece no checkout.
  const mealVoucherOptions = useMemo(
    () => normalizeMealVouchers(establishment?.accepted_meal_vouchers),
    [establishment?.accepted_meal_vouchers]
  );
  const mealVoucherAvailable = mealVoucherOptions.length > 0;

  const paymentOptions = useMemo(() => {
    // Formas presenciais primeiro (PIX na hora, cartão e dinheiro na entrega,
    // vale na entrega); o PIX Online fica por último.
    // Na retirada o pagamento acontece no balcão — os textos deixam isso claro.
    const localOptions = isPickup
      ? PAYMENT_OPTIONS.map((option) => {
          if (option.value === "cartao") {
            return {
              ...option,
              label: "Cartão",
              hint: "Crédito ou débito no balcão",
            };
          }
          if (option.value === "dinheiro") {
            return { ...option, hint: "Pague na retirada" };
          }
          return option;
        })
      : PAYMENT_OPTIONS;
    const mealVoucherOption = isPickup
      ? {
          ...MEAL_VOUCHER_OPTION,
          hint: "Pague na retirada com o cartão de vale",
        }
      : MEAL_VOUCHER_OPTION;

    const withMealVoucher = mealVoucherAvailable
      ? [...localOptions, mealVoucherOption]
      : localOptions;
    return pixOnlineAvailable
      ? [...withMealVoucher, PIX_ONLINE_OPTION]
      : withMealVoucher;
  }, [mealVoucherAvailable, pixOnlineAvailable, isPickup]);
  // A loja desligou o PIX Online com o checkout aberto: limpa a seleção.
  if (payment === "pix_online" && establishment && !pixOnlineAvailable) {
    setPayment("");
  }
  // A loja parou de aceitar vale na entrega (ou a bandeira escolhida saiu da
  // lista): limpa a seleção para não enviar um pagamento que a API recusaria.
  if (payment === MEAL_VOUCHER_PAYMENT_METHOD && establishment) {
    if (!mealVoucherAvailable) {
      setPayment("");
      if (mealVoucher) setMealVoucher("");
    } else if (mealVoucher && !mealVoucherOptions.includes(mealVoucher)) {
      setMealVoucher("");
    }
  }

  /** Segundos restantes do QR Code (recalculado a cada segundo). */
  const pixRemainingSeconds = useMemo(() => {
    const expiresAt = pixPayment?.expiresAt;
    if (!expiresAt) return null;
    const expiry = Date.parse(expiresAt);
    if (Number.isNaN(expiry)) return null;
    return Math.max(0, Math.floor((expiry - pixNow) / 1000));
  }, [pixPayment?.expiresAt, pixNow]);

  // Cronômetro ativo apenas enquanto aguarda o pagamento.
  useEffect(() => {
    if (pixPayment?.status !== "waiting") return;
    setPixNow(Date.now());
    const id = window.setInterval(() => setPixNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [pixPayment?.status]);

  // Polling de confirmação: o webhook do Asaas é a fonte primária; este ciclo
  // é fallback (e cobre ambientes onde o webhook ainda não foi configurado).
  useEffect(() => {
    const orderId = pixPayment?.orderId;
    if (!orderId || pixPayment?.status !== "waiting") return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(
          `/api/asaas/pix-payment?order_id=${encodeURIComponent(orderId)}`,
          { cache: "no-store" }
        );
        const data = (await res.json().catch(() => ({}))) as { paid?: boolean };
        if (cancelled || data.paid !== true) return;
        setPixPayment((prev) =>
          prev && prev.orderId === orderId ? { ...prev, status: "paid" } : prev
        );
      } catch {
        /* polling silencioso — tenta de novo no próximo ciclo */
      }
    };
    const id = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pixPayment?.orderId, pixPayment?.status]);

  // Pagamento confirmado: leva o cliente para o acompanhamento do pedido.
  useEffect(() => {
    if (pixPayment?.status !== "paid") return;
    const orderId = pixPayment.orderId;
    pixFlowDone.current = true;
    const id = window.setTimeout(() => router.replace(`/pedido/${orderId}`), 1800);
    return () => window.clearTimeout(id);
  }, [pixPayment?.status, pixPayment?.orderId, router]);

  // Cotação de entrega feita no servidor (fonte da verdade da taxa).
  // O estado é "chaveado" por loja+endereço: cotações antigas deixam de ser
  // consideradas automaticamente quando o endereço muda, sem precisar limpar
  // estado de forma síncrona dentro de um efeito.
  const [deliveryQuoteState, setDeliveryQuoteState] =
    useState<DeliveryQuoteState | null>(null);
  // Feedback da consulta de CEP usada para preencher rua/bairro.
  const [cepLookupState, setCepLookupState] =
    useState<CepLookupState | null>(null);
  // Coordenadas do endereço escolhido no Google Places (ou do último endereço
  // salvo na sessão). São a entrada preferida do cálculo de rota no servidor.
  const [deliveryPoint, setDeliveryPoint] = useState<DeliveryPoint | null>(() => {
    // O endereço da sacola tem prioridade; depois, o do perfil do cliente.
    const fromCart = toDeliveryPoint(deliveryAddress);
    if (fromCart) return fromCart;

    const saved = getCustomerProfile();
    return toDeliveryPoint(
      saved
        ? {
            cep: saved.cep,
            latitude: saved.latitude,
            longitude: saved.longitude,
            placeId: saved.placeId,
            street: saved.street,
            number: saved.number,
            neighborhood: saved.neighborhood,
            city: saved.city,
          }
        : null
    );
  });

  // A sacola pode hidratar depois do checkout (localStorage): aproveita as
  // coordenadas guardadas quando o formulário ainda não tem uma seleção.
  useEffect(() => {
    if (!deliveryAddress) return;
    setDeliveryPoint((prev) => prev ?? toDeliveryPoint(deliveryAddress));
  }, [deliveryAddress]);


  const [prevEstablishmentId, setPrevEstablishmentId] =
    useState(establishmentId);
  if (establishmentId !== prevEstablishmentId) {
    setPrevEstablishmentId(establishmentId);
    setEstablishment(null);
    setMenuMetaError(null);
  }

  useEffect(() => {
    if (slug) {
      let cancelled = false;
      (async () => {
        try {
          const res = await fetch(
            `/api/menu?slug=${encodeURIComponent(slug)}`
          );
          const data = (await res.json().catch(() => ({}))) as Partial<
            StorefrontMenu & { error?: string }
          >;
          if (!res.ok || !data.establishment) {
            throw new Error(data.error ?? "Loja não encontrada.");
          }
          const establishmentId = data.establishment.id;
          // Não validamos o formato UUID aqui — a API Supabase retorna sempre UUIDs
          // válidos para a tabela `establishments`. A validação rigorosa foi
          // movida para a rota POST /api/orders, onde o valor é gravado no banco.
          if (typeof establishmentId !== "string" || establishmentId.trim() === "") {
            throw new Error("ID da loja inválido no menu.");
          }
          const trimmedId = establishmentId.trim();
          if (!cancelled) {
            setEstablishment(data.establishment);
            setEstablishmentIdFromSlug(trimmedId);
            setMenuMetaError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setEstablishment(null);
            setEstablishmentIdFromSlug(null);
            setMenuMetaError(
              err instanceof Error ? err.message : "Erro inesperado."
            );
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (!establishmentIdFromCart) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/menu?establishment_id=${encodeURIComponent(establishmentIdFromCart)}`
        );
        const data = (await res.json().catch(() => ({}))) as Partial<
          StorefrontMenu & { error?: string }
        >;
        if (!res.ok || !data.establishment) {
          throw new Error(data.error ?? "Falha ao carregar a loja.");
        }
        const rawEstablishmentId = data.establishment.id;
        // Não validamos o formato UUID aqui — a API Supabase retorna sempre UUIDs
        // válidos para a tabela `establishments`.
        if (typeof rawEstablishmentId !== "string" || rawEstablishmentId.trim() === "") {
          throw new Error("ID da loja inválido no carrinho.");
        }
        if (!cancelled) {
          setEstablishment(data.establishment);
          setMenuMetaError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setEstablishment(null);
          setMenuMetaError(
            err instanceof Error ? err.message : "Erro inesperado."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, establishmentIdFromCart]);

  // ---- Cotação de entrega (servidor) --------------------------------------
  // O modelo por distância e/ou o raio máximo precisa de um endereço. A taxa é
  // sempre pré-visualizada por `POST /api/delivery-quote`; `POST /api/orders`
  // revalida e recalcula no servidor antes de gravar o pedido.
  //
  // O cliente NÃO digita CEP: a localização vem da busca automática de
  // endereço (Google Places → coordenadas exatas + CEP). Sem a sugestão, o
  // servidor só aceita um geocode que comprove o número; no modelo por km a
  // cotação é recusada se não houver posição exata (nada de centroide de rua).
  const cepDigits = parseCep(form.cep);
  // Mantém o contexto da sacola alinhado com o CEP devolvido pela busca
  // automática (usado pelo link do modo catálogo).
  useEffect(() => {
    if (cepDigits) setDeliveryCep(cepDigits);
  }, [cepDigits, setDeliveryCep]);
  const quoteEstablishmentId = establishment?.id ?? establishmentId;
  const deliveryNeedsGeo = Boolean(
    establishment &&
      !isPickup &&
      (establishment.delivery_type === "distance" ||
        establishment.max_delivery_radius_km != null)
  );
  // Assinatura do endereço que está no formulário agora. As coordenadas da
  // seleção (Places ou endereço salvo) só são usadas enquanto rua + número
  // baterem — se o cliente trocar o endereço, o ponto deixa de valer na hora,
  // sem depender de limpar estado dentro de eventos do widget.
  const activeDeliveryPoint =
    deliveryPoint && deliveryPointMatchesForm(deliveryPoint, form)
      ? deliveryPoint
      : null;
  // Modelo por km + autocomplete disponível: a taxa só é cotada com a posição
  // exata escolhida no Google. O servidor recusa centroide de rua (era o que
  // gerava distância de 1,4 km para um endereço a 13,4 km).
  const requiresPlacesSelection =
    deliveryNeedsGeo &&
    establishment?.delivery_type === "distance" &&
    isGooglePlacesEnabled();
  // Endereço digitado quando não há sugestão escolhida: o servidor tenta um
  // geocode exato (rua + número comprovado) e calcula a rota. Sem número
  // confirmado a cotação por km é recusada — nunca usamos centroide de rua.
  const typedAddress = useMemo(
    () => ({
      street: form.rua.trim(),
      number: form.numero.trim(),
      neighborhood: form.bairro.trim(),
      city: form.cidade.trim(),
    }),
    [form.rua, form.numero, form.bairro, form.cidade]
  );
  const hasTypedAddress = Boolean(typedAddress.street && typedAddress.number);
  const typedAddressKey = hasTypedAddress
    ? [
        typedAddress.street,
        typedAddress.number,
        typedAddress.neighborhood,
        typedAddress.city,
      ].join("|")
    : "";
  // Só consulta o servidor quando o modelo realmente depende da distância
  // (por km ou raio máximo). Lojas com taxa fixa seguem usando `delivery_fee`
  // local, sem chamadas externas de endereço no checkout.
  //
  // A chave inclui as coordenadas (ou o endereço digitado): trocar o endereço
  // invalida a cotação anterior e força um novo cálculo de rota.
  const quotePointKey = activeDeliveryPoint
    ? `${activeDeliveryPoint.latitude.toFixed(5)},${activeDeliveryPoint.longitude.toFixed(5)}`
    : "";
  const quoteKey =
    establishment &&
    deliveryNeedsGeo &&
    quoteEstablishmentId &&
    // Sem a seleção do autocomplete não há posição exata: não cotamos (o
    // servidor recusaria) e a UI pede que o cliente escolha uma sugestão.
    (!requiresPlacesSelection || activeDeliveryPoint != null) &&
    (cepDigits || activeDeliveryPoint || hasTypedAddress)
      ? `${quoteEstablishmentId}:${cepDigits ?? ""}:${quotePointKey}:${
          activeDeliveryPoint ? "" : typedAddressKey
        }`
      : null;

  useEffect(() => {
    if (!quoteKey || !quoteEstablishmentId) return;

    // Snapshot do endereço desta cotação (evita usar valores novos dentro do
    // timer quando o cliente continua digitando).
    const cepForQuote = cepDigits;
    const pointForQuote = activeDeliveryPoint;
    const addressForQuote = typedAddress;

    let cancelled = false;
    // Com coordenadas a resposta é imediata; sem elas o servidor precisa
    // geocodificar o texto, então esperamos o cliente parar de digitar.
    const debounceMs = pointForQuote || cepForQuote ? 300 : 800;
    const timer = window.setTimeout(async () => {
      // Atualização assíncrona (fora do corpo do efeito): evita renders em
      // cascata e mantém a cotação vinculada à chave consultada.
      setDeliveryQuoteState({
        key: quoteKey,
        quote: null,
        error: null,
        loading: true,
      });
      try {
        const res = await fetch("/api/delivery-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            establishment_id: quoteEstablishmentId,
            cep: cepForQuote ?? undefined,
            latitude: pointForQuote?.latitude,
            longitude: pointForQuote?.longitude,
            place_id: pointForQuote?.placeId ?? undefined,
            // Sem sugestão escolhida nem CEP, o servidor geocodifica o
            // endereço digitado (rua/número/bairro/cidade).
            address:
              pointForQuote || cepForQuote ? undefined : addressForQuote,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as DeliveryQuoteResponse;
        if (cancelled) return;
        if (!res.ok || !data.quote) {
          throw new Error(data.error ?? "Não foi possível calcular a entrega.");
        }
        setDeliveryQuoteState({
          key: quoteKey,
          quote: {
            ...data.quote,
            distance_km: data.distance_km ?? data.quote.distance_km ?? null,
            duration_minutes:
              data.duration_minutes ?? data.quote.duration_minutes ?? null,
            distance_source:
              data.distance_source ?? data.quote.distance_source ?? null,
          },
          error: null,
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        setDeliveryQuoteState({
          key: quoteKey,
          quote: null,
          error:
            err instanceof Error ? err.message : "Erro ao calcular a entrega.",
          loading: false,
        });
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    quoteKey,
    quoteEstablishmentId,
    cepDigits,
    activeDeliveryPoint,
    typedAddress,
  ]);

  const currentQuoteState =
    deliveryQuoteState && deliveryQuoteState.key === quoteKey
      ? deliveryQuoteState
      : null;
  const deliveryQuote = currentQuoteState?.quote ?? null;
  const deliveryQuoteError = currentQuoteState?.error ?? null;
  // Sem estado para a chave atual (ex.: durante o debounce) conta como cálculo
  // em andamento, bloqueando o envio até o servidor responder.
  const isQuotingDelivery =
    quoteKey != null && (currentQuoteState == null || currentQuoteState.loading);

  // Preenche rua/bairro a partir do CEP (sem sobrescrever o que o cliente já
  // digitou). A consulta é tolerante a falhas: o pedido segue com o endereço
  // manual quando o serviço externo estiver indisponível.
  useEffect(() => {
    if (!cepDigits) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setCepLookupState({ cep: cepDigits, error: null, loading: true });
      try {
        const res = await fetch(
          `/api/geocode?cep=${encodeURIComponent(cepDigits)}`
        );
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          address?: {
            street?: string | null;
            neighborhood?: string | null;
            city?: string | null;
          };
        };
        if (cancelled) return;
        if (!res.ok || !data.address) {
          throw new Error(data.error ?? "CEP não encontrado.");
        }
        const street = data.address.street?.trim() ?? "";
        const neighborhood = data.address.neighborhood?.trim() ?? "";
        const city = data.address.city?.trim() ?? "";
        setForm((prev) => ({
          ...prev,
          rua: prev.rua.trim() ? prev.rua : street || prev.rua,
          bairro: prev.bairro.trim()
            ? prev.bairro
            : neighborhood || prev.bairro,
          cidade: prev.cidade.trim() ? prev.cidade : city || prev.cidade,
        }));
        setCepLookupState({ cep: cepDigits, error: null, loading: false });
      } catch (err) {
        if (cancelled) return;
        setCepLookupState({
          cep: cepDigits,
          error:
            err instanceof Error
              ? err.message
              : "Não foi possível consultar o CEP.",
          loading: false,
        });
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cepDigits]);

  const currentCepLookup =
    cepLookupState && cepLookupState.cep === cepDigits ? cepLookupState : null;
  const cepLookupError = currentCepLookup?.error ?? null;
  const isLookingUpCep =
    cepDigits != null && (currentCepLookup == null || currentCepLookup.loading);

  // Taxa exibida: cotação do servidor ou fallback local (modelo fixo).
  // Retirada no balcão: não há entrega, então a taxa é sempre zero.
  const fixedDeliveryFee = Number(establishment?.delivery_fee ?? 0) || 0;
  const deliveryFee = isPickup
    ? 0
    : deliveryQuote?.fee ?? fixedDeliveryFee;
  const deliveryFeeKnown =
    isPickup ||
    deliveryQuote != null ||
    establishment?.delivery_type !== "distance";
  const deliveryDistanceKm =
    deliveryQuote?.distance_km != null && deliveryQuote.distance_km > 0
      ? deliveryQuote.distance_km
      : null;
  // Tempo de percurso estimado pelo Google Routes (null no fallback Haversine).
  const deliveryDurationLabel = formatTravelDuration(
    deliveryQuote?.duration_minutes ?? null
  );
  const deliveryOutOfRange = !isPickup && deliveryQuote?.within_radius === false;
  const deliveryOutOfRangeMessage = deliveryOutOfRange
    ? deliveryDistanceKm != null
      ? `Não entregamos nesta localização. Endereço a ${formatKm(
          deliveryDistanceKm
        )} km do estabelecimento` +
        (deliveryQuote.max_delivery_radius_km != null
          ? ` (limite máximo: ${formatKm(deliveryQuote.max_delivery_radius_km)} km).`
          : ".")
      : "Não entregamos nesta localização: endereço fora da área de entrega."
    : null;
  const deliveryAddressError = isPickup
    ? null
    : errors.cep ??
      deliveryQuoteError ??
      (cepDigits && !deliveryQuote && !isQuotingDelivery
        ? cepLookupError
        : null);

  // Status de funcionamento (horário de Brasília). Sem horários cadastrados,
  // a loja é considerada aberta (compatibilidade com bases legadas).
  // Depende de `isMounted` porque `now` vem do relógio do navegador: avaliado no
  // servidor (ou em build estático) o resultado divergiria do cliente e o aviso
  // "loja fechada" apareceria/sumiria na hidratação.
  const storeStatus = useMemo(
    () =>
      isMounted && establishment
        ? isStoreOpen(establishment.opening_hours, now)
        : null,
    [isMounted, establishment, now]
  );
  const storeClosed = storeStatus ? !storeStatus.isOpen : false;
  const nextOpeningLabel = storeStatus
    ? describeNextOpening(storeStatus.nextOpening)
    : null;

  // Linhas do pedido: com slug, só itens da loja; sem slug, todo o carrinho.
  const checkoutItems = slug ? storeItems : items;
  const storeTotal = useMemo(
    () =>
      storeItems.reduce((acc, item) => {
        if (typeof item.itemTotalPrice === "number") return acc + item.itemTotalPrice;
        const base = item.basePrice ?? 0;
        const unit = base + (item.selectedOptions ?? []).reduce((a, o) => a + o.price, 0);
        return acc + unit * item.quantidade;
      }, 0),
    [storeItems]
  );
  const storeCount = useMemo(
    () => storeItems.reduce((acc, item) => acc + item.quantidade, 0),
    [storeItems]
  );

  // Linhas do pedido derivadas exclusivamente do carrinho (snapshot por item).
  const lines = useMemo(
    () =>
      checkoutItems.map((item) => {
        const unit =
          typeof item.unitPrice === "number"
            ? item.unitPrice
            : (item.basePrice ?? 0) +
              (item.selectedOptions ?? []).reduce((a, o) => a + o.price, 0);
        const lineTotal =
          typeof item.itemTotalPrice === "number"
            ? item.itemTotalPrice
            : unit * item.quantidade;
        return { item, unit, lineTotal };
      }),
    [checkoutItems]
  );

  // Com slug usamos os totais da loja; sem slug, os totais globais do carrinho.
  const effectiveSubtotal = slug ? storeTotal : total;
  const effectiveCount = slug ? storeCount : itemCount;
  const subtotal = effectiveSubtotal;

  // Desconto do cupom: percentual/valor fixo incidem sobre o subtotal; frete
  // grátis abate a taxa de entrega. Recalculado a cada render (se a cotação da
  // entrega chegar depois, o frete grátis já usa o valor final).
  const couponDiscount =
    appliedCoupon && effectiveCount > 0
      ? computeCouponDiscount(
          appliedCoupon,
          subtotal,
          deliveryFeeKnown ? deliveryFee : 0
        )
      : 0;
  const couponMinNotMet =
    appliedCoupon != null &&
    appliedCoupon.min_order_value != null &&
    subtotal < appliedCoupon.min_order_value;

  // Pedido mínimo da loja (`establishments.min_order_value`): compara o
  // subtotal dos itens, sem a taxa de entrega. Bloqueia o envio e mostra
  // quanto falta — o servidor revalida em `POST /api/orders`.
  const minOrderValue = normalizeMinOrderValue(establishment?.min_order_value);
  const minOrderMessage = describeMinOrderShortfall(minOrderValue, subtotal);
  const minOrderBlocked = minOrderMessage != null;

  const grandTotal =
    effectiveCount > 0
      ? Math.max(
          0,
          subtotal +
            (deliveryFeeKnown ? deliveryFee : 0) -
            couponDiscount
        )
      : 0;

  // Previsão configurada pela loja (janela em minutos). O normalizador cai nos
  // padrões da migração quando a base ainda não possui as colunas, quando a
  // loja ainda não carregou ou quando os campos vêm vazios/nulos. O fallback
  // final garante que o banner sempre tenha um rótulo válido para renderizar.
  const estimatedDeliveryLabel =
    formatEstimatedDeliveryWindowLabel(
      normalizeEstimatedDeliveryWindow(establishment)
    ).trim() || DEFAULT_ESTIMATED_DELIVERY_LABEL;

  // Destino de retorno: com slug volta à vitrine da loja; sem slug, à raiz.
  const backHref = slug ? `/${slug}` : "/";

  // Separação "novo carrinho" × "pedido concluído": se o carrinho voltar a ter
  // itens, esta tela deixou de representar o pedido recém-confirmado (caso
  // típico: voltar pelo histórico do navegador, que restaura o estado deste
  // componente). Ajuste durante o render — mesmo padrão do reset de loja
  // acima — para que o cliente caia direto no formulário do novo pedido.
  if (orderConfirmed && effectiveCount > 0) {
    setOrderConfirmed(false);
    setConfirmedSummary(null);
  }

  // WhatsApp do estabelecimento (fallback: telefone da loja).
  const whatsappNumber = useMemo(() => {
    const raw = establishment?.whatsapp || establishment?.phone || "";
    return raw.replace(/\D/g, "");
  }, [establishment]);

  // Se o carrinho esvaziar após ter itens (ex: removendo tudo), volta ao cardápio.
  // Não redireciona quem abre o checkout já vazio (mostra estado vazio) nem o
  // fluxo de PIX Online (o carrinho é limpo antes de exibir o QR Code).
  useEffect(() => {
    if (!isHydrated || orderConfirmed || pixPayment || pixFlowDone.current) return;
    if (effectiveCount > 0) {
      hadItems.current = true;
      return;
    }
    if (hadItems.current && effectiveCount === 0) {
      router.replace(backHref);
    }
  }, [isHydrated, orderConfirmed, pixPayment, effectiveCount, router, backHref]);

  const updateField = (field: keyof DeliveryForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Editar rua/número/bairro/cidade invalida a seleção anterior: a assinatura
    // deixa de bater e `activeDeliveryPoint` vira `null` (a cotação não usa mais
    // as coordenadas). Nada de apagar o estado aqui — o widget do Google também
    // dispara `input` ao aplicar a sugestão, e a limpeza apagava a seleção
    // recém-feita; o checkout caía no geocode de texto e errava a distância.
    //
    // A sacola guarda o endereço para o próximo checkout; ao editar, as
    // coordenadas dela são descartadas para não transportar um ponto que
    // pertence a outro endereço.
    if (
      (field === "rua" ||
        field === "numero" ||
        field === "bairro" ||
        field === "cidade") &&
      deliveryAddress &&
      (deliveryAddress.latitude != null || deliveryAddress.placeId)
    ) {
      setDeliveryAddress({
        street: deliveryAddress.street,
        number: deliveryAddress.number,
        neighborhood: deliveryAddress.neighborhood,
        ...(deliveryAddress.city ? { city: deliveryAddress.city } : {}),
        ...(deliveryAddress.complement
          ? { complement: deliveryAddress.complement }
          : {}),
        ...(deliveryAddress.cep ? { cep: deliveryAddress.cep } : {}),
      });
    }
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  /**
   * Aplica o endereço escolhido no Google Places.
   *
   * Os campos são sobrescritos de propósito: o cliente acabou de confirmar um
   * endereço completo no dropdown e espera ver os dados corretos no formulário
   * (inclusive o número, que costuma vir da sugestão). O CEP vem de
   * `address.cep` (`readSelectedPlaceAddress`) e é preenchido automaticamente.
   */
  const handlePlaceSelected = (address: GooglePlaceAddress) => {
    const cep = address.cep;
    const street = address.street?.trim() ?? "";
    const number = address.number?.trim() ?? "";
    const neighborhood = address.neighborhood?.trim() ?? "";
    const city = address.city?.trim() ?? "";
    const formatted = address.formattedAddress?.trim() ?? "";

    // Valores que o formulário terá depois da seleção (mesma regra do `setForm`
    // abaixo): a assinatura precisa refletir o estado final, senão o ponto
    // seria considerado inválido no render seguinte.
    const nextStreet = street || formatted;
    const nextNumber = number || form.numero.trim();

    setForm((prev) => ({
      ...prev,
      // Sugestão sem CEP: limpa o valor antigo, que pertencia a outro endereço
      // (rua/número acabaram de ser trocados pelos da sugestão).
      cep: cep ? formatCep(cep) : "",
      rua: street || prev.rua,
      numero: number || prev.numero,
      bairro: neighborhood || prev.bairro,
      cidade: city || prev.cidade,
    }));

    if (address.latitude != null && address.longitude != null) {
      setDeliveryPoint({
        // Sem CEP na sugestão o ponto continua valendo: as coordenadas são a
        // fonte mais precisa para a rota.
        cep: cep ?? "",
        latitude: address.latitude,
        longitude: address.longitude,
        placeId: address.placeId,
        formattedAddress: formatted || null,
        signature: addressSignature({
          street: nextStreet,
          number: nextNumber,
        }),
      });
    } else {
      setDeliveryPoint(null);
    }

    // Mantém a sacola sincronizada com o endereço escolhido (o cliente volta
    // ao cardápio e a sacola já mostra o mesmo endereço; o próximo checkout
    // também abre preenchido).
    setDeliveryCep(cep ?? "");
    setDeliveryAddress({
      street,
      number,
      neighborhood,
      ...(city ? { city } : {}),
      ...(cep ? { cep } : {}),
      ...(address.latitude != null && address.longitude != null
        ? { latitude: address.latitude, longitude: address.longitude }
        : {}),
      ...(address.placeId ? { placeId: address.placeId } : {}),
      ...(formatted ? { formattedAddress: formatted } : {}),
    });
    setErrors((prev) => ({
      ...prev,
      cep: undefined,
      rua: undefined,
      numero: undefined,
      bairro: undefined,
    }));
  };

  /**
   * Cria (ou reaproveita) a cobrança PIX no Asaas para um pedido já gravado.
   *
   * `refresh` força uma cobrança nova — usado quando o QR Code expira.
   */
  const requestPixPayment = async (
    orderId: string,
    totalValue: number,
    refresh = false
  ) => {
    setPixCopied(false);
    setPixPayment((prev) => ({
      orderId,
      total: totalValue,
      status: "loading",
      payload: prev?.orderId === orderId ? prev.payload : null,
      encodedImage: prev?.orderId === orderId ? prev.encodedImage : null,
      error: null,
      expiresAt: prev?.orderId === orderId ? prev.expiresAt : null,
      platformFeeLabel: prev?.platformFeeLabel ?? "R$ 0,50",
    }));

    try {
      const res = await fetch("/api/asaas/pix-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId, refresh }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        paid?: boolean;
        payload?: string;
        encoded_image?: string;
        expires_at?: string | null;
        platform_fee_label?: string;
      };

      if (data.paid === true) {
        setPixPayment((prev) =>
          prev && prev.orderId === orderId ? { ...prev, status: "paid" } : prev
        );
        return;
      }

      if (!res.ok || typeof data.payload !== "string" || !data.payload) {
        throw new Error(data.error ?? "Não foi possível gerar o PIX Online.");
      }

      setPixPayment((prev) =>
        prev && prev.orderId === orderId
          ? {
              ...prev,
              status: "waiting",
              payload: data.payload ?? null,
              encodedImage:
                typeof data.encoded_image === "string"
                  ? data.encoded_image
                  : null,
              expiresAt:
                typeof data.expires_at === "string" ? data.expires_at : null,
              platformFeeLabel:
                typeof data.platform_fee_label === "string"
                  ? data.platform_fee_label
                  : prev.platformFeeLabel,
              error: null,
            }
          : prev
      );
    } catch (err) {
      setPixPayment((prev) =>
        prev && prev.orderId === orderId
          ? {
              ...prev,
              status: "error",
              error:
                err instanceof Error
                  ? err.message
                  : "Não foi possível gerar o PIX Online.",
            }
          : prev
      );
    }
  };

  /** Copia o Pix Copia e Cola (com fallback para navegadores antigos). */
  const handleCopyPix = async () => {
    const payload = pixPayment?.payload;
    if (!payload) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = payload;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setPixCopied(true);
      window.setTimeout(() => setPixCopied(false), 4000);
    } catch {
      setPixCopied(false);
    }
  };

  /** Fecha o pagamento e segue para o acompanhamento (pagamento pendente). */
  const handleClosePix = () => {
    const orderId = pixPayment?.orderId;
    pixFlowDone.current = true;
    setPixPayment(null);
    if (orderId) router.replace(`/pedido/${orderId}`);
  };

  /** QR Code expirado: gera uma nova cobrança para o mesmo pedido. */
  const handleRegeneratePix = () => {
    if (!pixPayment) return;
    void requestPixPayment(pixPayment.orderId, pixPayment.total, true);
  };

  /** Falha ao gerar o PIX: tenta de novo (reaproveita a mesma cobrança). */
  const handleRetryPix = () => {
    if (!pixPayment) return;
    void requestPixPayment(pixPayment.orderId, pixPayment.total);
  };

  const validate = (): FormErrors => {
    const next: FormErrors = {};

    if (form.nome.trim().length < 3) {
      next.nome = "Informe seu nome completo.";
    }

    const phoneDigits = form.telefone.replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      next.telefone = "Informe um telefone válido com DDD.";
    }

    // CPF/CNPJ: obrigatório no PIX Online (o Asaas exige o documento do
    // pagador para criar o cliente/cobrança); opcional nas demais formas.
    const documentDigits = form.documento.replace(/\D/g, "");
    if (payment === "pix_online" && !isValidCpfCnpj(documentDigits)) {
      next.documento = "Informe o CPF/CNPJ do pagador (obrigatório no PIX Online).";
    } else if (documentDigits && !isValidCpfCnpj(documentDigits)) {
      next.documento = "CPF/CNPJ inválido.";
    }

    // Endereço e cotação: só na modalidade de entrega. Na retirada o cliente
    // informa apenas nome e telefone (o pedido é retirado no balcão).
    if (!isPickup) {
      if (!form.rua.trim()) next.rua = "Informe a rua.";
      if (!form.numero.trim()) next.numero = "Informe o número.";
      if (!form.bairro.trim()) next.bairro = "Informe o bairro.";

      if (deliveryNeedsGeo) {
        if (requiresPlacesSelection && !activeDeliveryPoint) {
          // Sem a sugestão escolhida não existe latitude/longitude exata — e o
          // servidor recusa calcular a taxa a partir de um centroide de rua.
          next.rua =
            "Selecione o endereço na lista de sugestões para confirmar a localização exata da entrega.";
        } else if (!cepDigits && !activeDeliveryPoint && !hasTypedAddress) {
          next.cep =
            "Informe o endereço de entrega (rua e número) para calcular a taxa.";
        } else if (isQuotingDelivery) {
          next.cep = "Aguarde o cálculo da taxa de entrega.";
        } else if (deliveryOutOfRange) {
          next.cep =
            deliveryOutOfRangeMessage ??
            "Este endereço está fora da área de entrega.";
        } else if (deliveryQuoteError) {
          next.cep = deliveryQuoteError;
        } else if (!deliveryQuote) {
          next.cep = "Não foi possível calcular a entrega para este endereço.";
        }
      }
    }

    if (!payment) {
      next.pagamento = "Selecione a forma de pagamento.";
    } else if (
      payment === MEAL_VOUCHER_PAYMENT_METHOD &&
      !mealVoucherOptions.includes(mealVoucher)
    ) {
      // Vale na entrega: a bandeira é obrigatória (o entregador precisa saber
      // qual maquininha levar). A API revalida contra a lista da loja.
      next.pagamento = isPickup
        ? "Selecione a bandeira do vale-refeição que será usado na retirada."
        : "Selecione a bandeira do vale-refeição que será usado na entrega.";
    }

    return next;
  };

  /** Valida o cupom na API pública antes de aplicar o desconto no resumo. */
  const applyCoupon = async () => {
    const code = normalizeCouponCode(couponCode);
    if (!code) {
      setCouponError("Informe o código do cupom.");
      return;
    }
    if (!establishmentId && !slug) {
      setCouponError("Não foi possível identificar a loja do pedido.");
      return;
    }

    setIsApplyingCoupon(true);
    setCouponError(null);
    setSubmitError(null);
    try {
      const res = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishmentId,
          establishment_id: establishmentId,
          slug,
          code,
          subtotal: effectiveSubtotal,
          deliveryFee: deliveryFeeKnown ? deliveryFee : 0,
          customerPhone: normalizeCouponPhone(form.telefone),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        coupon?: {
          code: string;
          discount_type: AppliedCoupon["discount_type"];
          discount_value: number;
          min_order_value: number | null;
          max_uses?: number | null;
          usage_limit?: number | null;
          used_count?: number;
          first_order_only?: boolean;
          expires_at?: string | null;
        };
      };

      if (!res.ok || !data.coupon) {
        throw new Error(data.error ?? "Não foi possível aplicar o cupom.");
      }

      setAppliedCoupon({
        code: data.coupon.code,
        discount_type: data.coupon.discount_type,
        discount_value: data.coupon.discount_value,
        min_order_value: data.coupon.min_order_value,
        max_uses: data.coupon.max_uses ?? null,
        usage_limit: data.coupon.usage_limit ?? null,
        used_count: data.coupon.used_count ?? 0,
        first_order_only: data.coupon.first_order_only === true,
        expires_at: data.coupon.expires_at ?? null,
      });
      setAppliedCouponPhone(normalizeCouponPhone(form.telefone));
      setCouponCode(data.coupon.code);
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(
        err instanceof Error ? err.message : "Erro ao aplicar o cupom."
      );
    } finally {
      setIsApplyingCoupon(false);
    }
  };

  const removeCoupon = () => {
    setAppliedCoupon(null);
    setAppliedCouponPhone("");
    setCouponError(null);
    setCouponCode("");
    setSubmitError(null);
  };

  // Cupom de primeiro pedido: se o cliente alterar o telefone depois de
  // aplicar, o cupom é revalidado. Sem isso, alguém poderia aplicar com um
  // telefone sem histórico e finalizar o pedido com outro.
  const couponRevalidateSeq = useRef(0);
  useEffect(() => {
    if (!appliedCoupon?.first_order_only) return;

    const phone = normalizeCouponPhone(form.telefone);
    if (phone.length < 10 || phone === appliedCouponPhone) return;
    if (!establishmentId && !slug) return;

    const seq = ++couponRevalidateSeq.current;
    const timer = window.setTimeout(async () => {
      setIsApplyingCoupon(true);
      setCouponError(null);
      try {
        const res = await fetch("/api/coupons/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            establishmentId,
            establishment_id: establishmentId,
            slug,
            code: appliedCoupon.code,
            subtotal: effectiveSubtotal,
            deliveryFee: deliveryFeeKnown ? deliveryFee : 0,
            customerPhone: phone,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          coupon?: {
            code: string;
            discount_type: AppliedCoupon["discount_type"];
            discount_value: number;
            min_order_value: number | null;
            max_uses?: number | null;
            usage_limit?: number | null;
            used_count?: number;
            first_order_only?: boolean;
            expires_at?: string | null;
          };
        };
        if (seq !== couponRevalidateSeq.current) return;

        if (!res.ok || !data.coupon) {
          // Deixou de ser elegível com o novo telefone: remove o desconto para
          // o cliente não finalizar com um valor que a API recusaria.
          setAppliedCoupon(null);
          setAppliedCouponPhone("");
          setCouponError(data.error ?? "Este cupom não está mais disponível.");
          return;
        }

        setAppliedCoupon({
          code: data.coupon.code,
          discount_type: data.coupon.discount_type,
          discount_value: data.coupon.discount_value,
          min_order_value: data.coupon.min_order_value,
          max_uses: data.coupon.max_uses ?? null,
          usage_limit: data.coupon.usage_limit ?? null,
          used_count: data.coupon.used_count ?? 0,
          first_order_only: data.coupon.first_order_only === true,
          expires_at: data.coupon.expires_at ?? null,
        });
        setAppliedCouponPhone(phone);
      } catch {
        if (seq === couponRevalidateSeq.current) {
          setCouponError(
            "Não foi possível revalidar o cupom com o novo telefone."
          );
        }
      } finally {
        if (seq === couponRevalidateSeq.current) setIsApplyingCoupon(false);
      }
    }, 600);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    appliedCoupon,
    appliedCouponPhone,
    establishmentId,
    slug,
    effectiveSubtotal,
    deliveryFee,
    deliveryFeeKnown,
    form.telefone,
  ]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    // Bloqueio preventivo no cliente — a API também valida no servidor.
    if (storeClosed) {
      setSubmitError(
        "O estabelecimento encontra-se fechado no momento e não está recebendo pedidos."
      );
      return;
    }

    // Pedido mínimo da loja abaixo do exigido (a API recusa com a mesma regra).
    if (minOrderMessage) {
      setSubmitError(minOrderMessage);
      return;
    }

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      const firstField = Object.keys(validationErrors)[0];
      document
        .getElementById(`field-${firstField}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Se não há establishmentId mas há slug, ainda tentamos enviar — a API
    // resolverá o UUID pelo slug. Só bloqueia se faltar ambos.
    if (!establishmentId && !slug) {
      setSubmitError(
        menuMetaError ?? "Não foi possível identificar a loja do pedido."
      );
      return;
    }

    // Cupom aplicado deixou de valer (ex.: itens removidos e o subtotal caiu
    // abaixo do pedido mínimo) — bloqueia antes de chamar a API.
    if (appliedCoupon && couponMinNotMet) {
      setSubmitError(
        `O cupom ${appliedCoupon.code} exige um pedido mínimo de ${formatBRL(
          appliedCoupon.min_order_value ?? 0
        )}.`
      );
      return;
    }

    // Cupom sem desconto efetivo (ex.: frete grátis com entrega já gratuita):
    // bloqueia para não enviar um código que o servidor ignoraria.
    if (
      appliedCoupon &&
      couponDiscount <= 0 &&
      (appliedCoupon.discount_type !== "free_shipping" || deliveryFeeKnown)
    ) {
      setSubmitError(
        appliedCoupon.discount_type === "free_shipping"
          ? isPickup
            ? "Este cupom de frete grátis não se aplica a pedidos de retirada."
            : "O frete deste pedido já é grátis — remova o cupom para continuar."
          : "Este cupom não gera desconto para este pedido."
      );
      return;
    }

    // Se o establishmentId não é um UUID válido, ainda tentamos enviar com o
    // slug como fallback. A API resolverá o UUID pelo slug se necessário.
    if (establishmentId && !isValidUUID(establishmentId)) {
      console.warn("[CheckoutForm] establishmentId não é UUID válido, confiando no slug fallback:", establishmentId);
    }

    // Se establishmentId está ausente/inválido, envia como undefined para forçar
    // a resolução por slug na API.
    const establishmentIdToSend = establishmentId && isValidUUID(establishmentId)
      ? establishmentId
      : undefined;

    setErrors({});
    setSubmitError(null);
    setIsSubmitting(true);

    // Salva/atualiza o perfil do cliente de forma silenciosa antes de enviar,
    // para que o próximo checkout já venha pré-preenchido (reconhecimento).
    //
    // Na retirada o cliente pode não ter endereço no formulário: preserva o
    // endereço já salvo no perfil para não "apagar" os dados de entrega dele.
    const savedProfile = getCustomerProfile();
    const profileAddress =
      isPickup && savedProfile
        ? {
            ...(savedProfile.cep ? { cep: savedProfile.cep } : {}),
            street: savedProfile.street,
            number: savedProfile.number,
            neighborhood: savedProfile.neighborhood,
            ...(savedProfile.city ? { city: savedProfile.city } : {}),
            ...(savedProfile.complement
              ? { complement: savedProfile.complement }
              : {}),
            ...(savedProfile.latitude != null && savedProfile.longitude != null
              ? {
                  latitude: savedProfile.latitude,
                  longitude: savedProfile.longitude,
                }
              : {}),
            ...(savedProfile.placeId ? { placeId: savedProfile.placeId } : {}),
          }
        : {
            cep: cepDigits ?? undefined,
            street: form.rua.trim(),
            number: form.numero.trim(),
            neighborhood: form.bairro.trim(),
            ...(form.cidade.trim() ? { city: form.cidade.trim() } : {}),
            complement: form.complemento.trim() || undefined,
            // Coordenadas do endereço selecionado: no próximo checkout a
            // cotação já começa com a rota certa, sem depender da
            // geocodificação do CEP.
            ...(activeDeliveryPoint
              ? {
                  latitude: activeDeliveryPoint.latitude,
                  longitude: activeDeliveryPoint.longitude,
                  ...(activeDeliveryPoint.placeId
                    ? { placeId: activeDeliveryPoint.placeId }
                    : {}),
                }
              : {}),
          };
    saveCustomerProfile({
      name: form.nome.trim(),
      phone: form.telefone.trim(),
      ...profileAddress,
    });

    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Envia o slug como header para a API resolver o UUID se o
          // establishment_id vier inválido/ausente.
          ...(slug ? { "X-Establishment-Slug": slug } : {}),
        },
        body: JSON.stringify({
          establishment_id: establishmentIdToSend,
          slug: slug,
          // Modalidade de atendimento: `retirada` dispensa endereço e taxa de
          // entrega no servidor (a taxa nunca vem do navegador).
          order_type: orderType,
          customer: {
            name: form.nome.trim(),
            phone: form.telefone.trim(),
            // PIX Online: documento do pagador (somente dígitos).
            document: form.documento.replace(/\D/g, "") || undefined,
            cep: isPickup ? undefined : cepDigits ?? undefined,
            street: isPickup ? "" : form.rua.trim(),
            number: isPickup ? "" : form.numero.trim(),
            neighborhood: isPickup ? "" : form.bairro.trim(),
            city: isPickup ? undefined : form.cidade.trim() || undefined,
            complement: isPickup ? "" : form.complemento.trim(),
            reference: isPickup ? "" : form.referencia.trim(),
            // Coordenadas do Places: o servidor usa direto na rota (a taxa é
            // sempre recalculada lá, nunca aceita do navegador).
            latitude: isPickup ? undefined : activeDeliveryPoint?.latitude,
            longitude: isPickup ? undefined : activeDeliveryPoint?.longitude,
            place_id: isPickup
              ? undefined
              : activeDeliveryPoint?.placeId ?? undefined,
          },
          payment_method: payment,
          // Bandeira do vale-refeição/alimentação (só nesta modalidade). A API
          // revalida contra `establishments.accepted_meal_vouchers`.
          ...(payment === MEAL_VOUCHER_PAYMENT_METHOD
            ? { meal_voucher: mealVoucher }
            : {}),
          // A API revalida o cupom e recalcula o desconto no servidor.
          coupon_code: appliedCoupon?.code,
          // Troco sanitizado: só envia número válido quando for dinheiro com
          // valor > 0; senão omite (undefined some no JSON) para a API nunca
          // tentar gravar coluna inexistente/nula.
          change_for:
            payment === "dinheiro" && troco.trim()
              ? (() => {
                  const parsed = Number(troco.replace(/\./g, "").replace(",", "."));
                  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
                })()
              : undefined,
          items: lines.map(({ item, unit, lineTotal }) => ({
            productId: item.productId,
            quantity: item.quantidade,
            addonIds: (item.selectedOptions ?? []).map((o) => o.id),
            // Meio a meio: a API revalida os 2 sabores e recalcula o preço
            // (sabor mais caro) no servidor — nunca confia no total do cliente.
            ...(item.halfHalfFlavors && item.halfHalfFlavors.length === 2
              ? { halfHalfFlavorIds: item.halfHalfFlavors.map((f) => f.id) }
              : {}),
            notes: item.notes,
            unit_price: unit,
            line_total: lineTotal,
          })),
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        order?: {
          id: string;
          total?: number;
          estimated_delivery_time?: string | null;
          /** Resumo do pedido no WhatsApp da loja (null quando indisponível). */
          whatsapp_url?: string | null;
        };
      };

      if (!res.ok) {
        // Mostra a causa exata do erro em vez de uma mensagem genérica.
        const apiError =
          data.error ||
          data.message ||
          `Falha na requisição (HTTP ${res.status}).`;
        setSubmitError(apiError);
        setIsSubmitting(false);
        return;
      }

      const orderId =
        typeof data.order?.id === "string" ? data.order.id : null;
      // Redirecionamento pós-pedido: /pedido/[id] (usa `data.id` quando vier).
      const targetId = orderId ?? null;
      setIsSubmitting(false);
      // Grava o telefone do cliente no localStorage com a chave `customer_phone`
      // para que a página "Meus Pedidos" possa auto-carregar os pedidos.
      try {
        const phoneDigits = form.telefone.replace(/\D/g, "");
        if (phoneDigits.length >= 10) {
          localStorage.setItem("customer_phone", form.telefone.trim());
        }
      } catch {
        /* armazenamento indisponível */
      }
      // Encerra a compra atual: o carrinho é limpo por completo (estado global
      // + localStorage) e o id do pedido passa a viver SOMENTE na URL de
      // acompanhamento (`/pedido/[id]`) e no histórico do cliente (telefone
      // salvo para "Meus Pedidos"). O resumo abaixo fica congelado apenas para
      // a tela de confirmação — nada do pedido anterior fica no carrinho.
      // A previsão exibida na confirmação vem do pedido recém-criado (fonte da
      // verdade). Se a API não devolver o campo, mantém a janela configurada.
      const responseEstimate =
        typeof data.order?.estimated_delivery_time === "string" &&
        data.order.estimated_delivery_time.trim() !== ""
          ? data.order.estimated_delivery_time
          : null;
      const parsedResponseEstimate =
        parseEstimatedDeliveryWindow(responseEstimate);
      const confirmedEstimatedDeliveryTime = parsedResponseEstimate
        ? formatEstimatedDeliveryWindowLabel(parsedResponseEstimate)
        : responseEstimate ?? estimatedDeliveryLabel;
      // Resumo do pedido no WhatsApp: o servidor já aplicou as regras da loja
      // (flag `whatsapp_checkout_enabled` + número válido). Quando indisponível,
      // o pedido segue normalmente — apenas sem o botão.
      const whatsappUrl =
        typeof data.order?.whatsapp_url === "string" && data.order.whatsapp_url
          ? data.order.whatsapp_url
          : null;
      // O redirect para `/pedido/[id]` encerra esta tela; o link viaja pelo
      // sessionStorage para o botão aparecer no acompanhamento. Sem link,
      // limpamos resumos antigos para não misturar pedidos.
      if (whatsappUrl && targetId) {
        savePendingOrderWhatsAppUrl(targetId, whatsappUrl);
      } else {
        clearPendingOrderWhatsAppUrl();
      }
      // PIX Online: o pedido foi criado; a cobrança é gerada logo abaixo e a
      // tela de pagamento (QR Code) assume o lugar do checkout.
      const onlinePix = payment === "pix_online";
      const confirmedTotal =
        typeof data.order?.total === "number" ? data.order.total : grandTotal;
      setConfirmedSummary({
        total: confirmedTotal,
        establishmentName: establishment?.name ?? "",
        estimatedDeliveryTime: confirmedEstimatedDeliveryTime,
        whatsappUrl,
      });
      setOrderConfirmed(!onlinePix);
      clearCart();
      // Reseta os dados exclusivos desta compra para que um novo checkout
      // (inclusive quando o navegador restaura esta tela pelo histórico)
      // comece limpo, sem cupom/pagamento/troco herdados do pedido anterior.
      setAppliedCoupon(null);
      setAppliedCouponPhone("");
      setCouponCode("");
      setCouponError(null);
      setTroco("");
      setMealVoucher("");
      setPayment("");
      setErrors({});
      if (targetId) {
        if (onlinePix) {
          // Deixa o modal aberto e dispara a criação da cobrança PIX.
          setIsSubmitting(false);
          setPixPayment({
            orderId: targetId,
            total: confirmedTotal,
            status: "loading",
            payload: null,
            encodedImage: null,
            error: null,
            expiresAt: null,
            platformFeeLabel: "R$ 0,50",
          });
          void requestPixPayment(targetId, confirmedTotal);
          return;
        }
        router.replace(`/pedido/${targetId}`);
        return;
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setIsSubmitting(false);
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Erro ao enviar o pedido. Tente novamente."
      );
    }
  };

  // Tela de pedido confirmado (após simulação de envio).
  if (orderConfirmed) {
    return (
      <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
        <main className="flex flex-1 items-center justify-center px-4 py-12">
          <div className="w-full max-w-md rounded-2xl border border-gray-200/70 bg-white p-6 text-center shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60 sm:p-8">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-400/15 dark:text-green-400">
              <svg
                aria-hidden="true"
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m4.5 12.75 6 6 9-13.5"
                />
              </svg>
            </span>
            <h1 className="mt-4 text-xl font-bold text-gray-900 dark:text-white">
              Pedido confirmado!
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              Recebemos o seu pedido e a cozinha já começou a preparar. Você
              receberá as atualizações no WhatsApp informado.
            </p>
            <div className="mt-6 rounded-xl bg-gray-50 p-4 dark:bg-gray-900/60">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                {isPickup ? "Previsão de retirada" : "Previsão de entrega"}
              </p>
              <p className="mt-1 text-lg font-bold tabular-nums text-gray-900 dark:text-white">
                {confirmedSummary?.estimatedDeliveryTime ??
                  estimatedDeliveryLabel}
              </p>
              {confirmedSummary?.total ? (
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  Total pago:{" "}
                  <span className="font-semibold tabular-nums text-gray-900 dark:text-white">
                    {formatBRL(confirmedSummary.total)}
                  </span>
                </p>
              ) : null}
            </div>

            {/*
              * Resumo do pedido no WhatsApp oficial da loja (recurso opcional
              * controlado em `/painel/configuracoes`). O link já vem pronto do
              * servidor; quando indisponível, mantém o contato simples. O aviso
              * acima só aparece quando existe algum botão de WhatsApp.
              */}
            {(confirmedSummary?.whatsappUrl || whatsappNumber) && (
              <WhatsAppSendHint className="mt-5" />
            )}
            {confirmedSummary?.whatsappUrl ? (
              <a
                href={confirmedSummary.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.13c-.25.69-1.44 1.32-1.99 1.4-.51.08-1.16.11-1.87-.12-.43-.14-.98-.32-1.69-.62-2.97-1.28-4.91-4.27-5.06-4.47-.15-.2-1.21-1.61-1.21-3.07 0-1.46.77-2.18 1.04-2.48.27-.3.59-.37.79-.37.2 0 .39 0 .57.01.18.01.43-.07.67.51.24.59.83 2.03.9 2.18.07.15.12.32.02.52-.1.2-.15.32-.3.5-.15.17-.31.39-.45.52-.15.15-.3.31-.13.61.17.3.76 1.25 1.63 2.02 1.12.99 2.06 1.3 2.36 1.45.3.15.47.12.65-.07.17-.2.76-.89.96-1.19.2-.3.4-.25.67-.15.27.1 1.72.81 2.02.96.3.15.5.22.57.35.07.12.07.72-.18 1.41Z" />
                </svg>
                Enviar pedido no WhatsApp
              </a>
            ) : whatsappNumber ? (
              <a
                href={`https://wa.me/${whatsappNumber}?text=${encodeURIComponent(
                  `Olá! Acabei de fazer o pedido${
                    confirmedSummary?.establishmentName
                      ? ` na ${confirmedSummary.establishmentName}`
                      : ""
                  } e gostaria de acompanhar o status.`
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.13c-.25.69-1.44 1.32-1.99 1.4-.51.08-1.16.11-1.87-.12-.43-.14-.98-.32-1.69-.62-2.97-1.28-4.91-4.27-5.06-4.47-.15-.2-1.21-1.61-1.21-3.07 0-1.46.77-2.18 1.04-2.48.27-.3.59-.37.79-.37.2 0 .39 0 .57.01.18.01.43-.07.67.51.24.59.83 2.03.9 2.18.07.15.12.32.02.52-.1.2-.15.32-.3.5-.15.17-.31.39-.45.52-.15.15-.3.31-.13.61.17.3.76 1.25 1.63 2.02 1.12.99 2.06 1.3 2.36 1.45.3.15.47.12.65-.07.17-.2.76-.89.96-1.19.2-.3.4-.25.67-.15.27.1 1.72.81 2.02.96.3.15.5.22.57.35.07.12.07.72-.18 1.41Z" />
                </svg>
                Falar no WhatsApp
              </a>
            ) : null}

            <Link
              href={backHref}
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:focus:ring-yellow-400 dark:focus:ring-offset-gray-800"
            >
              Voltar ao cardápio
            </Link>
          </div>
        </main>
      </div>
    );
  }

  // Evita divergência de hidratação: só decide o estado do carrinho (e mostra
  // dados do perfil salvos no `localStorage`) depois que o cliente montou.
  if (!isHydrated || !isMounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 antialiased dark:bg-gray-950">
        <p className="text-sm font-medium text-gray-400">Carregando...</p>
      </div>
    );
  }

  // PIX Online: checkout concluído, aguardando a confirmação do pagamento.
  // Fica ANTES do estado "carrinho vazio" porque o carrinho já foi limpo após
  // a criação do pedido e a tela de pagamento precisa continuar visível.
  if (pixPayment) {
    return (
      <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
        <PixPaymentDialog
          establishmentName={establishment?.name ?? "Estabelecimento"}
          total={pixPayment.total}
          platformFeeLabel={pixPayment.platformFeeLabel}
          status={pixPayment.status}
          payload={pixPayment.payload}
          encodedImage={pixPayment.encodedImage}
          error={pixPayment.error}
          remainingSeconds={pixRemainingSeconds}
          copied={pixCopied}
          onCopy={handleCopyPix}
          onRegenerate={handleRegeneratePix}
          onRetry={handleRetryPix}
          onClose={handleClosePix}
        />
      </div>
    );
  }

  // Estado: carrinho vazio.
  if (effectiveCount === 0) {
    return (
      <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
        <header className="border-b border-gray-200/70 bg-white/90 px-4 py-3 backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/80 sm:px-6">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <Link
              href={backHref}
              aria-label="Voltar ao cardápio"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 text-gray-600 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 19.5 8.25 12l7.5-7.5"
                />
              </svg>
            </Link>
            <p className="font-bold text-gray-900 dark:text-white">Checkout</p>
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-12">
          <div className="w-full max-w-md rounded-2xl border border-gray-200/70 bg-white p-6 text-center shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400 dark:bg-gray-700/60 dark:text-gray-500">
              <svg
                aria-hidden="true"
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
                />
              </svg>
            </span>
            <h1 className="mt-4 text-lg font-bold text-gray-900 dark:text-white">
              Seu carrinho está vazio
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              Adicione delícias do nosso cardápio para finalizar o pedido.
            </p>
            <Link
              href={backHref}
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:focus:ring-yellow-400 dark:focus:ring-offset-gray-800"
            >
              Voltar ao cardápio
            </Link>
          </div>
        </main>
      </div>
    );
  }
  // Modo catálogo: a loja não usa o checkout — o pedido/orçamento vai direto
  // para o WhatsApp dela. Guarda defensiva para acessos por link antigo.
  if (isDirectWhatsAppCheckoutEnabled(establishment)) {
    const directUrl = buildCatalogWhatsAppUrl(establishment, {
      items: checkoutItems.map((item) => {
        const priceOnRequest = isCartItemPriceOnRequest(item);
        return {
          name: withHalfHalfLabel(item.productName, item.halfHalfFlavors),
          quantity: item.quantidade,
          unit_price: priceOnRequest ? null : item.unitPrice,
          line_total: priceOnRequest ? null : item.itemTotalPrice,
          price_on_request: priceOnRequest,
          addons: (item.selectedOptions ?? []).map((option) => ({
            name: option.name,
            price: priceOnRequest ? null : option.price,
          })),
          notes: item.notes ?? null,
        };
      }),
      deliveryCep: deliveryCep || null,
    });

    return (
      <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
        <header className="border-b border-gray-200/70 bg-white/90 px-4 py-3 backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/80 sm:px-6">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <Link
              href={backHref}
              aria-label="Voltar ao cardápio"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 text-gray-600 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 19.5 8.25 12l7.5-7.5"
                />
              </svg>
            </Link>
            <p className="font-bold text-gray-900 dark:text-white">
              Pedido pelo WhatsApp
            </p>
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-12">
          <div className="w-full max-w-md rounded-2xl border border-gray-200/70 bg-white p-6 text-center shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-400/15 dark:text-green-400">
              <svg
                aria-hidden="true"
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.625 9.75h6.75m-6.75 3.75h4.5M21 12c0 4.142-4.03 7.5-9 7.5a10.6 10.6 0 0 1-2.28-.245L4.5 21l1.14-3.42A6.9 6.9 0 0 1 3 12c0-4.142 4.03-7.5 9-7.5s9 3.358 9 7.5Z"
                />
              </svg>
            </span>
            <h1 className="mt-4 text-lg font-bold text-gray-900 dark:text-white">
              Esta loja recebe pedidos pelo WhatsApp
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              Monte sua sacola no cardápio e envie o pedido direto para o
              atendente — sem passar pelo checkout. Frete, pagamento e valores
              (inclusive itens “Sob Consulta”) são combinados na conversa.
            </p>
            {directUrl ? (
              <a
                href={directUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-600 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
              >
                Enviar pedido no WhatsApp
              </a>
            ) : (
              <p
                role="alert"
                className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
              >
                A loja ainda não cadastrou um WhatsApp válido para receber
                pedidos.
              </p>
            )}
            <Link
              href={backHref}
              className="mt-4 inline-block text-sm font-semibold text-gray-600 underline dark:text-gray-300"
            >
              Voltar ao cardápio
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const inputClassName = (field: keyof DeliveryForm) =>
    `w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 transition focus:outline-none focus:ring-2 dark:bg-gray-900/60 dark:text-white dark:placeholder:text-gray-500 ${
      errors[field]
        ? "border-red-400 focus:border-red-500 focus:ring-red-200 dark:focus:ring-red-500/20"
        : "border-gray-200 focus:border-gray-900 focus:ring-gray-900/10 dark:border-gray-700 dark:focus:border-yellow-400 dark:focus:ring-yellow-400/20"
    }`;

  const errorText = (field: keyof DeliveryForm) =>
    errors[field] ? (
      <p className="mt-1 text-xs font-medium text-red-500">{errors[field]}</p>
    ) : null;

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
      <header className="sticky top-0 z-40 border-b border-gray-200/70 bg-white/90 px-4 py-3 backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/80 sm:px-6">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Link
            href={backHref}
            aria-label="Voltar ao cardápio"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-gray-200 text-gray-600 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 19.5 8.25 12l7.5-7.5"
              />
            </svg>
          </Link>
          <div>
            <p className="font-bold leading-tight text-gray-900 dark:text-white">
              Finalizar Pedido
            </p>
            <p className="text-xs font-medium text-gray-400">
              Checkout seguro
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pb-32 pt-5 sm:px-6">
        <form
          id="checkout-form"
          onSubmit={handleSubmit}
          noValidate
          className="mx-auto flex max-w-2xl flex-col gap-5"
        >
          {/* Aviso de loja fechada — envio bloqueado no cliente e na API. */}
          {storeClosed && (
            <div
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/40"
            >
              <p className="text-sm font-bold text-red-700 dark:text-red-300">
                Estabelecimento fechado
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-red-600 dark:text-red-400">
                O estabelecimento encontra-se fechado no momento e não está
                recebendo pedidos.
                {nextOpeningLabel ? ` Abrimos ${nextOpeningLabel}.` : ""}
              </p>
            </div>
          )}

          {/* Banner de cliente reconhecido (perfil salvo no localStorage) */}
          {recognizedName && (
            <div
              role="status"
              className="flex items-start gap-3 rounded-2xl border border-yellow-400/40 bg-yellow-400/10 p-4 dark:border-yellow-400/30 dark:bg-yellow-400/10"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 text-lg leading-none"
              >
                👋
              </span>
              <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-200">
                <span className="font-bold text-gray-900 dark:text-white">
                  Bem-vindo de volta, {recognizedName}!
                </span>{" "}
                Já deixamos seus dados prontos — confirme as informações abaixo.
              </p>
            </div>
          )}

          {/* Erro de envio do pedido (API /api/orders) */}
          {submitError && (
            <div
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
            >
              {submitError}
            </div>
          )}

          {/* Seção 1: Resumo do Pedido */}
          <section
            aria-labelledby="resumo-title"
            className="rounded-2xl border border-gray-200/70 bg-white p-4 shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60 sm:p-5"
          >
            <h2
              id="resumo-title"
              className="text-base font-bold text-gray-900 dark:text-white"
            >
              Resumo do Pedido
            </h2>

            <ul className="mt-4 flex flex-col gap-3">
              {lines.map(({ item, lineTotal, unit }) => (
                <li key={item.id} className="flex items-start gap-3">
                  <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-700/60">
                    {item.imageUrl && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={item.imageUrl}
                        alt={item.productName ?? "Item"}
                        width={56}
                        height={56}
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                      {item.productName ?? "Produto"}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {item.quantidade} × {formatBRL(unit)}
                    </p>
                    {/* Ajuste de quantidade da linha no carrinho */}
                    <div className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-700/60">
                      <button
                        type="button"
                        aria-label={`Diminuir a quantidade de ${item.productName ?? "item"}`}
                        onClick={() =>
                          setLineQuantity(item.id, item.quantidade - 1)
                        }
                        className="flex h-6 w-6 items-center justify-center rounded-md bg-white text-xs font-bold leading-none text-gray-700 shadow-sm transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-800 dark:text-gray-200"
                      >
                        −
                      </button>
                      <span
                        aria-live="polite"
                        aria-label={`Quantidade: ${item.quantidade}`}
                        className="min-w-5 text-center text-xs font-bold tabular-nums text-gray-900 dark:text-white"
                      >
                        {item.quantidade}
                      </span>
                      <button
                        type="button"
                        aria-label={`Aumentar a quantidade de ${item.productName ?? "item"}`}
                        onClick={() =>
                          setLineQuantity(item.id, item.quantidade + 1)
                        }
                        className="flex h-6 w-6 items-center justify-center rounded-md bg-gray-900 text-xs font-bold leading-none text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-yellow-400 dark:text-gray-950"
                      >
                        +
                      </button>
                    </div>
                    {item.halfHalfFlavors && item.halfHalfFlavors.length > 0 && (
                      <p className="mt-0.5 line-clamp-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                        {halfHalfFlavorsLabel(item.halfHalfFlavors)}
                      </p>
                    )}
                    {(item.selectedOptions?.length ?? 0) > 0 && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                        {item.selectedOptions.map((o) => o.name).join(" • ")}
                      </p>
                    )}
                    {item.notes && (
                      <p className="mt-0.5 line-clamp-2 text-xs italic text-gray-400">
                        Obs: {item.notes}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => removeLine(item.id)}
                      aria-label={`Remover ${item.productName ?? "item"} do pedido`}
                      className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-semibold text-red-500 transition hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-400/40 rounded-md"
                    >
                      <svg
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="m14.74 9-.35 9m-4.78 0L9.26 9m9.97-3.21c.34.05.68.11 1.02.17m-1.02-.17L18.16 19.67a2.25 2.25 0 0 1-2.24 2.08H8.08a2.25 2.25 0 0 1-2.24-2.08L4.77 5.79m14.46 0a48.1 48.1 0 0 0-3.48-.4m-12 .56c.34-.06.68-.12 1.02-.17m0 0a48.11 48.11 0 0 1 3.48-.4m7.5 0v-.92c0-1.18-.91-2.16-2.09-2.2a52.05 52.05 0 0 0-3.32 0c-1.18.04-2.09 1.02-2.09 2.2v.92m7.5 0a48.09 48.09 0 0 0-7.5 0"
                        />
                      </svg>
                      Remover
                    </button>
                  </div>
                  <span className="shrink-0 text-sm font-bold tabular-nums text-gray-900 dark:text-white">
                    {formatBRL(lineTotal)}
                  </span>
                </li>
              ))}
            </ul>

            {/* Cupom de desconto */}
            <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-3 dark:border-gray-700">
              <label
                htmlFor="cupom"
                className="block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
              >
                Cupom de desconto
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="cupom"
                  name="cupom"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  placeholder="Ex.: DESCONTO10"
                  value={couponCode}
                  onChange={(event) => {
                    setCouponCode(event.target.value.toUpperCase());
                    if (couponError) setCouponError(null);
                  }}
                  disabled={Boolean(appliedCoupon) || isApplyingCoupon}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm uppercase tracking-wide text-gray-900 placeholder:normal-case placeholder:text-gray-400 transition focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/10 disabled:bg-gray-50 disabled:text-gray-500 dark:border-gray-700 dark:bg-gray-900/60 dark:text-white dark:disabled:bg-gray-800/60"
                />
                {appliedCoupon ? (
                  <button
                    type="button"
                    onClick={removeCoupon}
                    className="shrink-0 rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm font-semibold text-gray-600 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Remover
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={applyCoupon}
                    disabled={isApplyingCoupon || effectiveCount === 0}
                    className="shrink-0 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
                  >
                    {isApplyingCoupon ? "Aplicando..." : "Aplicar"}
                  </button>
                )}
              </div>
              {couponError && (
                <p role="alert" className="mt-2 text-xs font-medium text-red-500">
                  {couponError}
                </p>
              )}
              {appliedCoupon &&
                !couponError &&
                (couponMinNotMet ? (
                  <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                    Este cupom exige pedido mínimo de{" "}
                    {formatBRL(appliedCoupon.min_order_value ?? 0)}.
                  </p>
                ) : (
                  <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    Cupom {appliedCoupon.code} aplicado (
                    {couponDiscountLabel(appliedCoupon)}) — você economiza{" "}
                    {formatBRL(couponDiscount)}.
                    {appliedCoupon.first_order_only
                      ? " Válido apenas no primeiro pedido."
                      : ""}
                  </p>
                ))}
            </div>

            <dl className="mt-4 flex flex-col gap-2 border-t border-dashed border-gray-200 pt-4 text-sm dark:border-gray-700">
              <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{formatBRL(subtotal)}</dd>
              </div>
              <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
                <dt>
                  {isPickup ? (
                    "Retirada no balcão"
                  ) : (
                    <>
                      Taxa de entrega
                      {deliveryDistanceKm != null
                        ? ` (${formatKm(deliveryDistanceKm)} km)`
                        : ""}
                    </>
                  )}
                </dt>
                <dd className="tabular-nums">
                  {isPickup
                    ? "Sem taxa"
                    : isQuotingDelivery && !deliveryFeeKnown
                      ? "Calculando..."
                      : deliveryFeeKnown
                        ? formatBRL(deliveryFee)
                        : "A calcular"}
                </dd>
              </div>
              {!isPickup && deliveryQuote && deliveryQuote.warnings.length > 0 && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  {deliveryQuote.warnings.join(" ")}
                </p>
              )}
              {deliveryOutOfRange && (
                <p
                  role="alert"
                  className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-300"
                >
                  {deliveryOutOfRangeMessage ??
                    "O endereço informado está fora da área de entrega desta loja."}
                </p>
              )}
              {couponDiscount > 0 && (
                <div className="flex items-center justify-between font-semibold text-emerald-600 dark:text-emerald-400">
                  <dt>
                    {appliedCoupon?.discount_type === "free_shipping"
                      ? "Frete grátis"
                      : "Desconto"}
                    {appliedCoupon ? ` (${appliedCoupon.code})` : ""}
                  </dt>
                  <dd className="tabular-nums">−{formatBRL(couponDiscount)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-gray-200 pt-2 font-bold text-gray-900 dark:border-gray-700 dark:text-white">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatBRL(grandTotal)}</dd>
              </div>
            </dl>

            {minOrderMessage && (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-semibold leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
              >
                {minOrderMessage}
              </p>
            )}

            {/*
              Previsão de entrega configurada pela loja (janela mínima/máxima em
              minutos). Fica logo abaixo do resumo financeiro para o cliente
              saber quando o pedido chega antes de finalizar a compra. Sempre
              renderizado: enquanto a loja não carrega (ou se a API não devolver
              a janela), `estimatedDeliveryLabel` exibe o fallback padrão.
            */}
            <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-yellow-400/40 bg-yellow-400/10 px-3 py-2.5 dark:border-yellow-400/30 dark:bg-yellow-400/10">
              <span aria-hidden="true" className="text-base leading-none">
                ⏱️
              </span>
              <p className="text-sm font-semibold text-gray-900 dark:text-white">
                {isPickup ? "Previsão de retirada" : "Previsão de entrega"}:{" "}
                <span className="font-bold text-yellow-700 dark:text-yellow-300">
                  {estimatedDeliveryLabel}
                </span>
              </p>
            </div>
          </section>

          {/* Seção 2: Modalidade de atendimento (entrega x retirada) */}
          <section
            aria-labelledby="modalidade-title"
            className="rounded-2xl border border-gray-200/70 bg-white p-4 shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60 sm:p-5"
          >
            <h2
              id="modalidade-title"
              className="text-base font-bold text-gray-900 dark:text-white"
            >
              Como você quer receber?
            </h2>
            <div
              role="radiogroup"
              aria-labelledby="modalidade-title"
              className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2"
            >
              <button
                type="button"
                role="radio"
                aria-checked={!isPickup}
                onClick={() => setOrderType("entrega")}
                className={`rounded-xl border p-3.5 text-left transition focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-yellow-400 ${
                  !isPickup
                    ? "border-gray-900 bg-gray-50 shadow-sm dark:border-yellow-400 dark:bg-gray-900/60"
                    : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-600"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden="true">🛵</span>
                  <span className="block text-sm font-semibold text-gray-900 dark:text-white">
                    Receber em casa (Delivery)
                  </span>
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  Entregamos no endereço informado — taxa de entrega aplicada.
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={isPickup}
                onClick={() => setOrderType("retirada")}
                className={`rounded-xl border p-3.5 text-left transition focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-yellow-400 ${
                  isPickup
                    ? "border-gray-900 bg-gray-50 shadow-sm dark:border-yellow-400 dark:bg-gray-900/60"
                    : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-600"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden="true">🛍️</span>
                  <span className="block text-sm font-semibold text-gray-900 dark:text-white">
                    Retirar no Estabelecimento
                  </span>
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  Sem taxa de entrega — você busca no balcão da loja.
                </span>
              </button>
            </div>
          </section>

          {/* Seção 3: Dados do cliente (entrega ou retirada) */}
          <section
            aria-labelledby="entrega-title"
            className="rounded-2xl border border-gray-200/70 bg-white p-4 shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60 sm:p-5"
          >
            <h2
              id="entrega-title"
              className="text-base font-bold text-gray-900 dark:text-white"
            >
              {isPickup ? "Dados para Retirada" : "Dados de Entrega"}
            </h2>

            <div className="mt-4 flex flex-col gap-4">
              <div id="field-nome">
                <label
                  htmlFor="nome"
                  className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >
                  Nome completo
                </label>
                <input
                  id="nome"
                  name="nome"
                  type="text"
                  autoComplete="name"
                  placeholder="Ex.: João Silva"
                  value={form.nome}
                  onChange={(event) => updateField("nome", event.target.value)}
                  aria-invalid={errors.nome ? true : undefined}
                  className={inputClassName("nome")}
                />
                {errorText("nome")}
              </div>

              <div id="field-telefone">
                <label
                  htmlFor="telefone"
                  className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >
                  Telefone / WhatsApp
                </label>
                <input
                  id="telefone"
                  name="telefone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="(11) 99999-9999"
                  value={form.telefone}
                  onChange={(event) =>
                    updateField("telefone", event.target.value)
                  }
                  aria-invalid={errors.telefone ? true : undefined}
                  className={inputClassName("telefone")}
                />
                {errorText("telefone")}
              </div>

              <div id="field-documento">
                <label
                  htmlFor="documento"
                  className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >
                  CPF/CNPJ do pagador{" "}
                  <span className="font-normal text-gray-400">
                    {payment === "pix_online"
                      ? "(obrigatório no PIX Online)"
                      : "(opcional)"}
                  </span>
                </label>
                <input
                  id="documento"
                  name="documento"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="000.000.000-00"
                  value={form.documento}
                  onChange={(event) =>
                    updateField("documento", event.target.value)
                  }
                  aria-invalid={errors.documento ? true : undefined}
                  className={inputClassName("documento")}
                />
                {errorText("documento")}
              </div>

              {/* Retirada: sem endereço. Só nome, telefone e o aviso do balcão. */}
              {isPickup && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-xs leading-relaxed text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <p className="font-bold">Retirada no balcão</p>
                  <p className="mt-1">
                    Você recebe uma mensagem quando o pedido estiver{" "}
                    <strong>pronto para buscar</strong>
                    {establishment?.name ? ` na ${establishment.name}` : ""}.
                    Não é necessário informar endereço.
                  </p>
                </div>
              )}

              {/* Endereço completo: exclusivo da modalidade de entrega. */}
              {!isPickup && (
                <>
              <div className="flex flex-col gap-4 sm:flex-row">
                <div id="field-rua" className="flex-1">
                  <label
                    htmlFor="rua"
                    className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Rua
                  </label>
                  <AddressAutocomplete
                    id="rua"
                    name="rua"
                    placeholder="Ex.: Rua das Flores, 123"
                    autoComplete="address-line1"
                    value={form.rua}
                    onChange={(value) => updateField("rua", value)}
                    onPlaceSelected={handlePlaceSelected}
                    ariaInvalid={Boolean(errors.rua)}
                    className={inputClassName("rua")}
                  />
                  {errorText("rua")}
                  {/*
                    Validação visual da seleção: o cliente vê o endereço
                    formatado devolvido pelo Google e as coordenadas exatas que
                    serão usadas na rota (mesma base do Google Maps).
                  */}
                  {activeDeliveryPoint ? (
                    <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
                      <p className="font-bold">Endereço confirmado</p>
                      <p className="mt-0.5 break-words">
                        {activeDeliveryPoint.formattedAddress ??
                          [form.rua, form.numero, form.bairro, form.cidade]
                            .map((part) => part.trim())
                            .filter(Boolean)
                            .join(", ")}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-emerald-700 dark:text-emerald-300">
                        {activeDeliveryPoint.latitude.toFixed(6)},{" "}
                        {activeDeliveryPoint.longitude.toFixed(6)}
                      </p>
                    </div>
                  ) : (
                    !errors.rua &&
                    isGooglePlacesEnabled() && (
                      <p
                        className={
                          requiresPlacesSelection &&
                          (form.rua.trim() || form.numero.trim())
                            ? "mt-1 text-xs font-medium text-amber-600 dark:text-amber-400"
                            : "mt-1 text-xs leading-relaxed text-gray-400 dark:text-gray-500"
                        }
                      >
                        {requiresPlacesSelection
                          ? "Escolha uma sugestão da lista: é ela que define a latitude e a longitude exatas usadas no cálculo da entrega."
                          : "Escolha uma sugestão para preencher bairro, cidade e a localização da entrega automaticamente."}
                      </p>
                    )
                  )}
                </div>

                <div id="field-numero" className="sm:w-32">
                  <label
                    htmlFor="numero"
                    className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Número
                  </label>
                  <input
                    id="numero"
                    name="numero"
                    type="text"
                    inputMode="numeric"
                    placeholder="123"
                    value={form.numero}
                    onChange={(event) =>
                      updateField("numero", event.target.value)
                    }
                    aria-invalid={errors.numero ? true : undefined}
                    className={inputClassName("numero")}
                  />
                  {errorText("numero")}
                </div>
              </div>

              {/*
                Feedback da entrega (taxa, distância, área de cobertura).
                O CEP não é digitado pelo cliente: a localização vem da busca
                automática de endereço (ou é geocodificada no servidor).
                Mantém `id="field-cep"` para o scroll automático de validação.
              */}
              <div id="field-cep" className="flex flex-col gap-1">
                {(isLookingUpCep || isQuotingDelivery) && (
                  <p
                    aria-live="polite"
                    className="text-xs font-medium text-gray-500 dark:text-gray-400"
                  >
                    {isQuotingDelivery
                      ? "Calculando a taxa de entrega..."
                      : "Buscando o endereço..."}
                  </p>
                )}
                {errorText("cep")}
                {!errors.cep && deliveryAddressError && (
                  <p role="alert" className="text-xs font-medium text-red-500">
                    {deliveryAddressError}
                  </p>
                )}
                {deliveryOutOfRange && !errors.cep && deliveryOutOfRangeMessage && (
                  <p role="alert" className="text-xs font-medium text-red-500">
                    {deliveryOutOfRangeMessage}
                  </p>
                )}
                {!deliveryOutOfRange &&
                  !errors.cep &&
                  deliveryQuote &&
                  deliveryDistanceKm != null && (
                    <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      {deliveryQuote.distance_source === "google_routes"
                        ? "Distância pela rota"
                        : "Distância aproximada"}
                      : {formatKm(deliveryDistanceKm)} km
                      {deliveryDurationLabel
                        ? ` · ~${deliveryDurationLabel} de percurso`
                        : ""}{" "}
                      — entrega de {formatBRL(deliveryQuote.fee)}.
                    </p>
                  )}
              </div>

              <div className="flex flex-col gap-4 sm:flex-row">
                <div id="field-bairro" className="flex-1">
                  <label
                    htmlFor="bairro"
                    className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Bairro
                  </label>
                  <input
                    id="bairro"
                    name="bairro"
                    type="text"
                    autoComplete="address-level2"
                    placeholder="Ex.: Centro"
                    value={form.bairro}
                    onChange={(event) =>
                      updateField("bairro", event.target.value)
                    }
                    aria-invalid={errors.bairro ? true : undefined}
                    className={inputClassName("bairro")}
                  />
                  {errorText("bairro")}
                </div>

                <div id="field-cidade" className="flex-1">
                  <label
                    htmlFor="cidade"
                    className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Cidade{" "}
                    <span className="font-normal text-gray-400">
                      (opcional)
                    </span>
                  </label>
                  <input
                    id="cidade"
                    name="cidade"
                    type="text"
                    autoComplete="address-level2"
                    placeholder="Ex.: São José do Rio Preto"
                    value={form.cidade}
                    onChange={(event) =>
                      updateField("cidade", event.target.value)
                    }
                    className={inputClassName("cidade")}
                  />
                  {errorText("cidade")}
                </div>
              </div>

              <div className="flex flex-col gap-4 sm:flex-row">
                <div id="field-complemento" className="flex-1">
                  <label
                    htmlFor="complemento"
                    className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Complemento{" "}
                    <span className="font-normal text-gray-400">
                      (opcional)
                    </span>
                  </label>
                  <input
                    id="complemento"
                    name="complemento"
                    type="text"
                    placeholder="Apto, bloco..."
                    value={form.complemento}
                    onChange={(event) =>
                      updateField("complemento", event.target.value)
                    }
                    className={inputClassName("complemento")}
                  />
                </div>

                <div id="field-referencia" className="flex-1">
                  <label
                    htmlFor="referencia"
                    className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Ponto de referência{" "}
                    <span className="font-normal text-gray-400">
                      (opcional)
                    </span>
                  </label>
                  <input
                    id="referencia"
                    name="referencia"
                    type="text"
                    placeholder="Ex.: Próximo ao mercado"
                    value={form.referencia}
                    onChange={(event) =>
                      updateField("referencia", event.target.value)
                    }
                    className={inputClassName("referencia")}
                  />
                </div>
              </div>
                </>
              )}
            </div>
          </section>

          {/* Seção 4: Forma de Pagamento */}
          <section
            aria-labelledby="pagamento-title"
            className="rounded-2xl border border-gray-200/70 bg-white p-4 shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60 sm:p-5"
          >
            <h2
              id="pagamento-title"
              className="text-base font-bold text-gray-900 dark:text-white"
            >
              Forma de Pagamento
            </h2>

            <div
              id="field-pagamento"
              role="radiogroup"
              aria-labelledby="pagamento-title"
              className="mt-4 flex flex-col gap-2.5"
            >
              {paymentOptions.map((option) => {
                const isActive = payment === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => {
                      setPayment(option.value);
                      if (errors.pagamento) {
                        setErrors((prev) => ({
                          ...prev,
                          pagamento: undefined,
                        }));
                      }
                    }}
                    className={`flex items-center gap-3 rounded-xl border p-3.5 text-left transition focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-yellow-400 ${
                      isActive
                        ? "border-gray-900 bg-gray-50 shadow-sm dark:border-yellow-400 dark:bg-gray-900/60"
                        : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-600"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                        isActive
                          ? "border-gray-900 dark:border-yellow-400"
                          : "border-gray-300 dark:border-gray-600"
                      }`}
                    >
                      {isActive && (
                        <span className="h-2.5 w-2.5 rounded-full bg-gray-900 dark:bg-yellow-400" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-gray-900 dark:text-white">
                        {option.label}
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {option.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {errors.pagamento && (
              <p className="mt-2 text-xs font-medium text-red-500">
                {errors.pagamento}
              </p>
            )}

            {payment === "pix_online" && (
              <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
                Após confirmar o pedido você recebe o QR Code para pagar no app
                do seu banco. A confirmação é automática — taxa de serviço online
                de R$ 0,50 retida pela plataforma, sem custo extra para você.
              </p>
            )}

            {payment === "dinheiro" && (
              <div id="field-troco" className="mt-4">
                <label
                  htmlFor="troco"
                  className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >
                  Precisa de troco para quanto?{" "}
                  <span className="font-normal text-gray-400">
                    (opcional)
                  </span>
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm font-medium text-gray-400">
                    R$
                  </span>
                  <input
                    id="troco"
                    name="troco"
                    type="text"
                    inputMode="decimal"
                    placeholder="Ex.: 100,00"
                    value={troco}
                    onChange={(event) => setTroco(event.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-12 pr-3.5 text-sm text-gray-900 placeholder:text-gray-400 transition focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/10 dark:border-gray-700 dark:bg-gray-900/60 dark:text-white dark:placeholder:text-gray-500 dark:focus:border-yellow-400 dark:focus:ring-yellow-400/20"
                  />
                </div>
              </div>
            )}

            {payment === MEAL_VOUCHER_PAYMENT_METHOD && (
              <div id="field-vale" className="mt-4">
                <label
                  htmlFor="meal-voucher"
                  className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >
                  {isPickup
                    ? "Qual bandeira do vale você vai usar na retirada?"
                    : "Qual bandeira do vale você vai usar na entrega?"}
                </label>
                <select
                  id="meal-voucher"
                  name="meal_voucher"
                  value={mealVoucher}
                  onChange={(event) => {
                    setMealVoucher(event.target.value);
                    if (errors.pagamento) {
                      setErrors((prev) => ({
                        ...prev,
                        pagamento: undefined,
                      }));
                    }
                  }}
                  aria-invalid={errors.pagamento ? true : undefined}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 transition focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/10 dark:border-gray-700 dark:bg-gray-900/60 dark:text-white dark:focus:border-yellow-400 dark:focus:ring-yellow-400/20"
                >
                  <option value="">Selecione a bandeira…</option>
                  {mealVoucherOptions.map((voucher) => (
                    <option key={voucher} value={voucher}>
                      {voucher}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  {isPickup ? (
                    <>
                      O pagamento é feito <strong>na retirada</strong>, na
                      maquininha do balcão — nada é cobrado online pelo sistema.
                      Tenha o cartão de vale em mãos ao buscar o pedido.
                    </>
                  ) : (
                    <>
                      O pagamento é feito <strong>na entrega</strong>, na
                      maquininha do entregador — nada é cobrado online pelo
                      sistema. Tenha o cartão de vale em mãos no momento da
                      entrega.
                    </>
                  )}
                </p>
              </div>
            )}
          </section>
        </form>
      </main>
      {/* Barra de ação fixa */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200/70 bg-white/95 px-4 pb-6 pt-3 backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/95 sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          {/* Lembrete curto do pedido mínimo junto do botão (o alerta completo
              fica no resumo do pedido); o botão permanece desabilitado. */}
          {minOrderBlocked && (
            <p className="mb-2 text-[11px] font-semibold leading-snug text-amber-700 dark:text-amber-300">
              Pedido mínimo de {formatBRL(minOrderValue)} — faltam{" "}
              {formatBRL(minOrderShortfall(minOrderValue, subtotal))}.
            </p>
          )}
          <div className="flex w-full items-center gap-4">
            <div className="flex flex-col">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                Total
              </span>
              <span className="text-lg font-bold tabular-nums text-gray-900 dark:text-white">
                {formatBRL(grandTotal)}
              </span>
            </div>
            <button
              type="submit"
              form="checkout-form"
              disabled={isSubmitting || storeClosed || minOrderBlocked}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:focus:ring-yellow-400 dark:focus:ring-offset-gray-900"
            >
              {isSubmitting ? (
                <>
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth={4}
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  Enviando...
                </>
              ) : storeClosed ? (
                "Loja fechada"
              ) : minOrderBlocked ? (
                "Pedido mínimo não atingido"
              ) : (
                "Confirmar Pedido"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}



