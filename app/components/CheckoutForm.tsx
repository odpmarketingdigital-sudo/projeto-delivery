"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCart } from "@/context/CartContext";
import type { StorefrontMenu } from "@/lib/types";
import { describeNextOpening, isStoreOpen } from "@/lib/openingHours";
import { formatCep, parseCep, type DeliveryQuote } from "@/lib/delivery";
import {
  formatEstimatedDeliveryWindowLabel,
  normalizeEstimatedDeliveryWindow,
  parseEstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";
import {
  computeCouponDiscount,
  normalizeCouponCode,
  type AppliedCoupon,
} from "@/lib/coupons";
import {
  getCustomerProfile,
  saveCustomerProfile,
} from "@/lib/storage";

type PaymentMethod = "pix" | "cartao" | "dinheiro";

interface DeliveryForm {
  nome: string;
  telefone: string;
  cep: string;
  rua: string;
  numero: string;
  bairro: string;
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

/** Cotação vinculada à chave loja+CEP que a originou. */
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
  quote?: DeliveryQuotePreview;
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
  cep: "",
  rua: "",
  numero: "",
  bairro: "",
  complemento: "",
  referencia: "",
};

const PAYMENT_OPTIONS: { value: PaymentMethod; label: string; hint: string }[] =
  [
    { value: "pix", label: "Pix", hint: "Aprovação na hora" },
    { value: "cartao", label: "Cartão na Entrega", hint: "Crédito ou débito" },
    { value: "dinheiro", label: "Dinheiro", hint: "Pague ao entregador" },
  ];

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
  } = useCart();

  const [form, setForm] = useState<DeliveryForm>(() => {
    // Pré-preenchimento a partir do perfil salvo (reconhecimento do cliente).
    // Seguro contra divergência de hidratação: o formulário só é renderizado
    // quando `isHydrated` é true, e durante a hidratação `getCustomerProfile`
    // retorna os dados apenas no cliente (no servidor, `window` é undefined).
    //
    // O CEP escolhido na sacola tem prioridade sobre o CEP do perfil: ele é o
    // endereço que o cliente acabou de cotar e deve seguir para o checkout.
    const saved = getCustomerProfile();
    const preferredCep = deliveryCep || saved?.cep || "";
    const formattedCep = preferredCep ? formatCep(preferredCep) : "";
    if (!saved) return { ...INITIAL_FORM, cep: formattedCep };
    return {
      nome: saved.name,
      telefone: saved.phone,
      cep: formattedCep,
      rua: saved.street,
      numero: saved.number,
      bairro: saved.neighborhood,
      complemento: saved.complement ?? "",
      referencia: "",
    };
  });

  // O contexto do carrinho pode hidratar depois deste componente (localStorage).
  // Quando isso acontece, leva o CEP da sacola para o formulário uma única vez.
  const [syncedDeliveryCep, setSyncedDeliveryCep] = useState(deliveryCep);
  if (deliveryCep !== syncedDeliveryCep) {
    setSyncedDeliveryCep(deliveryCep);
    if (deliveryCep) {
      setForm((prev) => ({ ...prev, cep: formatCep(deliveryCep) }));
    }
  }
  const [errors, setErrors] = useState<FormErrors>({});
  const [payment, setPayment] = useState<PaymentMethod | "">("");
  const [troco, setTroco] = useState("");
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
  // Resumo congelado no momento da confirmação (o carrinho é limpo em seguida).
  const [confirmedSummary, setConfirmedSummary] = useState<{
    total: number;
    establishmentName: string;
    estimatedDeliveryTime: string | null;
  } | null>(null);
  // Nome do cliente reconhecido (perfil salvo) para o banner "Bem-vindo de volta".
  // Lido uma única vez na montagem; não muda durante a sessão do checkout.
  const [recognizedName] = useState<string | null>(
    () => getCustomerProfile()?.name ?? null
  );
  // Relógio local para o status aberto/fechado (atualiza a cada minuto).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // Rastreia se já houve itens para só redirecionar quando o carrinho ESVAZIAR.
  const hadItems = useRef(false);

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

  // Cotação de entrega feita no servidor (fonte da verdade da taxa).
  // O estado é "chaveado" por loja+CEP: cotações antigas deixam de ser
  // consideradas automaticamente quando qualquer um dos dois muda, sem
  // precisar limpar estado de forma síncrona dentro de um efeito.
  const [deliveryQuoteState, setDeliveryQuoteState] =
    useState<DeliveryQuoteState | null>(null);
  // Feedback da consulta de CEP usada para preencher rua/bairro.
  const [cepLookupState, setCepLookupState] =
    useState<CepLookupState | null>(null);

  // Reseta quando a loja derivada do carrinho muda — ajuste durante o render
  // (padrão recomendado pelo React; mesmo padrão de PainelProdutos).
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
  // O modelo por distância e/ou o raio máximo exigem um CEP válido. A taxa é
  // sempre pré-visualizada por `POST /api/delivery-quote`; `POST /api/orders`
  // revalida e recalcula no servidor antes de gravar o pedido.
  const cepDigits = parseCep(form.cep);
  // Mantém o contexto da sacola alinhado quando o cliente ajusta o CEP aqui —
  // assim, ao voltar ao cardápio, a sacola já mostra o mesmo endereço cotado.
  useEffect(() => {
    if (cepDigits) setDeliveryCep(cepDigits);
  }, [cepDigits, setDeliveryCep]);
  const quoteEstablishmentId = establishment?.id ?? establishmentId;
  const deliveryNeedsCep = Boolean(
    establishment &&
      (establishment.delivery_type === "distance" ||
        establishment.max_delivery_radius_km != null)
  );
  // Só consulta o servidor quando o modelo realmente depende da distância
  // (por km ou raio máximo). Lojas com taxa fixa seguem usando `delivery_fee`
  // local, sem chamadas externas de CEP no checkout.
  const quoteKey =
    establishment &&
    deliveryNeedsCep &&
    quoteEstablishmentId &&
    cepDigits
      ? `${quoteEstablishmentId}:${cepDigits}`
      : null;

  useEffect(() => {
    if (!quoteKey || !quoteEstablishmentId || !cepDigits) return;

    let cancelled = false;
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
            cep: cepDigits,
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
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [quoteKey, quoteEstablishmentId, cepDigits]);

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
          };
        };
        if (cancelled) return;
        if (!res.ok || !data.address) {
          throw new Error(data.error ?? "CEP não encontrado.");
        }
        const street = data.address.street?.trim() ?? "";
        const neighborhood = data.address.neighborhood?.trim() ?? "";
        setForm((prev) => ({
          ...prev,
          rua: prev.rua.trim() ? prev.rua : street || prev.rua,
          bairro: prev.bairro.trim()
            ? prev.bairro
            : neighborhood || prev.bairro,
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
  const fixedDeliveryFee = Number(establishment?.delivery_fee ?? 0) || 0;
  const deliveryFee = deliveryQuote?.fee ?? fixedDeliveryFee;
  const deliveryFeeKnown =
    deliveryQuote != null || establishment?.delivery_type !== "distance";
  const deliveryDistanceKm =
    deliveryQuote?.distance_km != null && deliveryQuote.distance_km > 0
      ? deliveryQuote.distance_km
      : null;
  const deliveryOutOfRange = deliveryQuote?.within_radius === false;
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
  const deliveryCepError =
    errors.cep ??
    deliveryQuoteError ??
    (cepDigits && !deliveryQuote && !isQuotingDelivery
      ? cepLookupError
      : null);

  // Status de funcionamento (horário de Brasília). Sem horários cadastrados,
  // a loja é considerada aberta (compatibilidade com bases legadas).
  const storeStatus = useMemo(
    () =>
      establishment ? isStoreOpen(establishment.opening_hours, now) : null,
    [establishment, now]
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

  // Desconto do cupom calculado sobre o subtotal (nunca sobre a taxa de entrega).
  const couponDiscount =
    appliedCoupon && effectiveCount > 0
      ? computeCouponDiscount(appliedCoupon, subtotal)
      : 0;
  const couponMinNotMet =
    appliedCoupon != null &&
    appliedCoupon.min_order_value != null &&
    subtotal < appliedCoupon.min_order_value;

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
  // Não redireciona quem abre o checkout já vazio (mostra estado vazio).
  useEffect(() => {
    if (!isHydrated || orderConfirmed) return;
    if (effectiveCount > 0) {
      hadItems.current = true;
      return;
    }
    if (hadItems.current && effectiveCount === 0) {
      router.replace(backHref);
    }
  }, [isHydrated, orderConfirmed, effectiveCount, router, backHref]);

  const updateField = (field: keyof DeliveryForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Mantém a sacola sincronizada também quando o CEP é editado no checkout
    // (inclusive ao apagar o valor, para não deixar um CEP antigo na sacola).
    if (field === "cep") setDeliveryCep(parseCep(value) ?? "");
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
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

    if (!form.rua.trim()) next.rua = "Informe a rua.";
    if (!form.numero.trim()) next.numero = "Informe o número.";
    if (!form.bairro.trim()) next.bairro = "Informe o bairro.";

    if (form.cep.trim() && !cepDigits) {
      next.cep = "Informe um CEP válido com 8 dígitos.";
    } else if (deliveryNeedsCep) {
      if (!cepDigits) {
        next.cep = "Informe o CEP para calcular a taxa de entrega.";
      } else if (isQuotingDelivery) {
        next.cep = "Aguarde o cálculo da taxa de entrega.";
      } else if (deliveryOutOfRange) {
        next.cep =
          deliveryOutOfRangeMessage ??
          "Este endereço está fora da área de entrega.";
      } else if (deliveryQuoteError) {
        next.cep = deliveryQuoteError;
      } else if (!deliveryQuote) {
        next.cep = "Não foi possível calcular a entrega para este CEP.";
      }
    }

    if (!payment) next.pagamento = "Selecione a forma de pagamento.";

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
          establishment_id: establishmentId,
          slug,
          code,
          subtotal: effectiveSubtotal,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        coupon?: {
          code: string;
          discount_type: "percentage" | "fixed";
          discount_value: number;
          min_order_value: number | null;
          usage_limit?: number | null;
          used_count?: number;
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
        usage_limit: data.coupon.usage_limit ?? null,
        used_count: data.coupon.used_count ?? 0,
      });
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
    setCouponError(null);
    setCouponCode("");
    setSubmitError(null);
  };

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
    saveCustomerProfile({
      name: form.nome.trim(),
      phone: form.telefone.trim(),
      cep: cepDigits ?? undefined,
      street: form.rua.trim(),
      number: form.numero.trim(),
      neighborhood: form.bairro.trim(),
      complement: form.complemento.trim() || undefined,
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
          customer: {
            name: form.nome.trim(),
            phone: form.telefone.trim(),
            cep: cepDigits ?? undefined,
            street: form.rua.trim(),
            number: form.numero.trim(),
            neighborhood: form.bairro.trim(),
            complement: form.complemento.trim(),
            reference: form.referencia.trim(),
          },
          payment_method: payment,
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
      setConfirmedSummary({
        total:
          typeof data.order?.total === "number"
            ? data.order.total
            : grandTotal,
        establishmentName: establishment?.name ?? "",
        estimatedDeliveryTime: confirmedEstimatedDeliveryTime,
      });
      setOrderConfirmed(true);
      clearCart();
      // Reseta os dados exclusivos desta compra para que um novo checkout
      // (inclusive quando o navegador restaura esta tela pelo histórico)
      // comece limpo, sem cupom/pagamento/troco herdados do pedido anterior.
      setAppliedCoupon(null);
      setCouponCode("");
      setCouponError(null);
      setTroco("");
      setPayment("");
      setErrors({});
      if (targetId) {
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
                Previsão de entrega
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

            {/* Enviar comprovante/duvida pelo WhatsApp do estabelecimento */}
            {whatsappNumber && (
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
            )}

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

  // Evita divergência de hidratação: só decide o estado do carrinho no cliente.
  if (!isHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 antialiased dark:bg-gray-950">
        <p className="text-sm font-medium text-gray-400">Carregando...</p>
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
            {/* Marca da plataforma no topo do checkout. */}
            <Image
              src="/logotipo.svg"
              alt="Ipepper"
              width={323}
              height={150}
              unoptimized
              className="ml-auto h-6 w-auto"
            />
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
          {/* Marca da plataforma no topo do checkout. */}
          <Image
            src="/logotipo.svg"
            alt="Ipepper"
            width={323}
            height={150}
            unoptimized
            className="ml-auto h-6 w-auto"
          />
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
                Já deixamos seus dados prontos — confirme as informações para
                entrega abaixo.
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
                    Cupom {appliedCoupon.code} aplicado — você economiza{" "}
                    {formatBRL(couponDiscount)}.
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
                  Taxa de entrega
                  {deliveryDistanceKm != null
                    ? ` (${formatKm(deliveryDistanceKm)} km)`
                    : ""}
                </dt>
                <dd className="tabular-nums">
                  {isQuotingDelivery && !deliveryFeeKnown
                    ? "Calculando..."
                    : deliveryFeeKnown
                      ? formatBRL(deliveryFee)
                      : "A calcular"}
                </dd>
              </div>
              {deliveryQuote && deliveryQuote.warnings.length > 0 && (
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
                    "O CEP informado está fora da área de entrega desta loja."}
                </p>
              )}
              {couponDiscount > 0 && (
                <div className="flex items-center justify-between font-semibold text-emerald-600 dark:text-emerald-400">
                  <dt>Desconto{appliedCoupon ? ` (${appliedCoupon.code})` : ""}</dt>
                  <dd className="tabular-nums">−{formatBRL(couponDiscount)}</dd>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-gray-200 pt-2 font-bold text-gray-900 dark:border-gray-700 dark:text-white">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatBRL(grandTotal)}</dd>
              </div>
            </dl>

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
                Previsão de entrega:{" "}
                <span className="font-bold text-yellow-700 dark:text-yellow-300">
                  {estimatedDeliveryLabel}
                </span>
              </p>
            </div>
          </section>

          {/* Seção 2: Dados de Entrega */}
          <section
            aria-labelledby="entrega-title"
            className="rounded-2xl border border-gray-200/70 bg-white p-4 shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60 sm:p-5"
          >
            <h2
              id="entrega-title"
              className="text-base font-bold text-gray-900 dark:text-white"
            >
              Dados de Entrega
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

              <div id="field-cep">
                <label
                  htmlFor="cep"
                  className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                >
                  CEP
                  {deliveryNeedsCep && (
                    <span className="ml-1 text-xs font-medium text-gray-400">
                      (necessário para calcular a entrega)
                    </span>
                  )}
                </label>
                <div className="relative">
                  <input
                    id="cep"
                    name="cep"
                    type="text"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    placeholder="00000-000"
                    maxLength={9}
                    value={form.cep}
                    onChange={(event) =>
                      updateField("cep", formatCep(event.target.value))
                    }
                    aria-invalid={errors.cep ? true : undefined}
                    className={inputClassName("cep")}
                  />
                  {(isLookingUpCep || isQuotingDelivery) && (
                    <span
                      aria-live="polite"
                      className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-gray-400"
                    >
                      {isQuotingDelivery ? "Calculando frete..." : "Buscando..."}
                    </span>
                  )}
                </div>
                {errorText("cep")}
                {!errors.cep && deliveryCepError && (
                  <p role="alert" className="mt-1 text-xs font-medium text-red-500">
                    {deliveryCepError}
                  </p>
                )}
                {deliveryOutOfRange && !errors.cep && deliveryOutOfRangeMessage && (
                  <p
                    role="alert"
                    className="mt-1 text-xs font-medium text-red-500"
                  >
                    {deliveryOutOfRangeMessage}
                  </p>
                )}
                {!deliveryOutOfRange &&
                  !errors.cep &&
                  deliveryQuote &&
                  deliveryDistanceKm != null && (
                    <p className="mt-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      Distância aproximada: {formatKm(deliveryDistanceKm)} km —
                      entrega de {formatBRL(deliveryQuote.fee)}.
                    </p>
                  )}
              </div>

              <div className="flex flex-col gap-4 sm:flex-row">
                <div id="field-rua" className="flex-1">
                  <label
                    htmlFor="rua"
                    className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Rua
                  </label>
                  <input
                    id="rua"
                    name="rua"
                    type="text"
                    autoComplete="address-line1"
                    placeholder="Ex.: Rua das Flores"
                    value={form.rua}
                    onChange={(event) => updateField("rua", event.target.value)}
                    aria-invalid={errors.rua ? true : undefined}
                    className={inputClassName("rua")}
                  />
                  {errorText("rua")}
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
              </div>

              <div id="field-referencia">
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
          </section>

          {/* Seção 3: Forma de Pagamento */}
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
              {PAYMENT_OPTIONS.map((option) => {
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
          </section>
        </form>
      </main>
      {/* Barra de ação fixa */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200/70 bg-white/95 px-4 pb-6 pt-3 backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/95 sm:px-6">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-4">
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
            disabled={isSubmitting || storeClosed}
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
            ) : (
              "Confirmar Pedido"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}



