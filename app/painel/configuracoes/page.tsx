/**
 * Configurações do estabelecimento — `/painel/configuracoes`.
 *
 * Tela **operacional**: aqui o lojista informa apenas os dados da própria
 * operação (nome, descrição, horário, entrega/frete, pedido mínimo,
 * vale-refeição e imagens da vitrine) e, quando houver, os dados de
 * recebimento online (subconta Asaas da loja).
 *
 * O WhatsApp da loja **não** é editado aqui: o número de atendimento e os
 * disparos do sistema são geridos pela conexão da Evolution API em
 * `/painel/whatsapp-ia`. O checkout continua lendo `establishments.whatsapp`
 * (definido no cadastro) para montar o link "enviar resumo no WhatsApp".
 *
 * Nada de configuração global/sensível da plataforma fica aqui: prompt mestre
 * e tom de voz da IA, cadeia de modelos, instâncias de WhatsApp, chaves de API e
 * preço do plano são geridos pelo Superadmin em `/painel/admin/...` (ver
 * "Arquitetura de permissões" no README).
 */

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useEstablishment } from "@/app/painel/produtos/useEstablishment";
import { createClient } from "@/lib/supabase/client";
import type { Establishment, OpeningHours } from "@/lib/types";
import {
  WEEKDAYS,
  DEFAULT_OPEN_TIME,
  DEFAULT_CLOSE_TIME,
  toEditableOpeningHours,
} from "@/lib/openingHours";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import {
  formatCep,
  normalizeDeliverySettings,
  normalizeStoreAddress,
  parseCep,
  toFiniteNumber,
  STORE_ADDRESS_MAX_LENGTH,
  STORE_ADDRESS_MIN_LENGTH,
  type DeliveryType,
} from "@/lib/delivery";
import {
  DEFAULT_ESTIMATED_DELIVERY_TIME_MAX,
  DEFAULT_ESTIMATED_DELIVERY_TIME_MIN,
  MAX_ESTIMATED_DELIVERY_MINUTES,
  MIN_ESTIMATED_DELIVERY_MINUTES,
} from "@/lib/deliveryEstimate";
import { formatWhatsAppPhoneForDisplay } from "@/lib/whatsappOrder";
import {
  formatCurrencyInput,
  formatCurrencyValue,
  parseCurrencyInput,
} from "@/lib/currency";
import { normalizeMinOrderValue } from "@/lib/minOrder";
import {
  MAX_MEAL_VOUCHER_NAME_LENGTH,
  MAX_MEAL_VOUCHERS,
  MEAL_VOUCHER_OPTIONS,
  normalizeMealVoucherName,
  normalizeMealVouchers,
} from "@/lib/mealVouchers";
import {
  BANNER_IMAGE_PRESET,
  LOGO_IMAGE_PRESET,
  resizeAndCropToWebP,
  type ImagePreset,
  type ResizedImage,
} from "@/lib/image-resize";
import {
  formatCpfCnpjInput,
  formatPhoneInput,
  formatPostalCodeInput,
} from "@/lib/billing";
import {
  ASAAS_COMPANY_TYPES,
  ASAAS_COMPANY_TYPE_LABELS,
  EMPTY_ASAAS_SUBACCOUNT_FORM,
  PLATFORM_FEE_LABEL,
  isAsaasCompanyType,
  resolveOnlinePaymentStatus,
  validateAsaasSubaccountForm,
  type AsaasSubaccountForm,
  type OnlinePaymentStatusTone,
} from "@/lib/asaasSubaccount";

const STORAGE_BUCKET = "products";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const ACCEPT_ATTR = ACCEPTED_IMAGE_TYPES.join(",");
const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "webp"]);

/**
 * Cores do badge de situação do recebimento online (classes estáticas para o
 * Tailwind). `active` = recebendo; `paused` = subconta pronta com o PIX
 * desligado no cardápio; `inactive` = nenhuma subconta criada.
 */
const ONLINE_PAYMENT_STATUS_BADGE_CLASSES: Record<
  OnlinePaymentStatusTone,
  string
> = {
  active: "bg-green-100 text-green-700",
  paused: "bg-amber-100 text-amber-800",
  inactive: "bg-slate-100 text-slate-600",
};

/**
 * Presets de recorte/otimização aplicados **no navegador** antes do upload:
 * a logo vira um quadrado 1:1 de 500×500 e o banner um retângulo 3:1 de
 * 1200×400, ambos em WebP 85% (ver `lib/image-resize.ts`).
 */
const IMAGE_PRESETS: Record<"logo_url" | "banner_url", ImagePreset> = {
  logo_url: LOGO_IMAGE_PRESET,
  banner_url: BANNER_IMAGE_PRESET,
};

interface PreviewState {
  /**
   * `processing` = canvas recortando/convertendo; `uploading` = enviando o
   * arquivo já otimizado para o Storage; `stored` = URL pública disponível.
   */
  status: "idle" | "processing" | "uploading" | "stored";
  url?: string;
  /**
   * Object URL (`URL.createObjectURL`) da imagem **já otimizada** — usada para
   * a prévia antes (e durante) o upload para o Storage.
   * Revogada quando substituída, removida ou ao desmontar o componente.
   */
  previewUrl?: string;
  /** Nome do arquivo exibido ao lado do botão (o otimizado, quando houver). */
  fileName?: string;
  /** Tamanho do arquivo em bytes (formatado na interface como KB/MB). */
  fileSize?: number;
  /** Tamanho do arquivo original escolhido pelo lojista (para comparação). */
  originalSize?: number;
  /** Largura final em pixels (após o recorte/redimensionamento). */
  width?: number;
  /** Altura final em pixels (após o recorte/redimensionamento). */
  height?: number;
  error?: string;
}

const VISUAL_FIELDS: {
  key: "logo_url" | "banner_url";
  label: string;
  hint: string;
  /** Texto exibido no estado vazio (quando não há imagem salva nem preview). */
  emptyText: string;
}[] = [
  { key: "logo_url", label: "Logo do estabelecimento", hint: "500 × 500 px (1:1)", emptyText: "Nenhuma logo definida" },
  { key: "banner_url", label: "Banner/cover da loja", hint: "1200 × 400 px (3:1)", emptyText: "Nenhum banner definido" },
];


function fileNameFor(file: File): string {
  const name = file.name.includes(".") ? (file.name.split(".").pop() ?? "").toLowerCase() : "";
  const ext = name && ALLOWED_EXT.has(name) ? name : "";
  return `${crypto.randomUUID()}${ext ? "." + ext : ".png"}`;
}

function buildStoragePath(establishmentId: string, fileName: string): string {
  return `${establishmentId}/${fileName}`;
}

/**
 * Formata o tamanho do arquivo para exibição ao lado do botão de upload.
 * Ex.: `950` → "950 B" · `245760` → "240 KB" · `2516582` → "2,4 MB".
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

/**
 * Estilo compartilhado dos inputs de horário (`type="time"`).
 * `[color-scheme:light]` mantém o seletor nativo legível no tema escuro.
 */
const timeInputClass =
  "w-[7.5rem] rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition [color-scheme:light] focus:border-amber-500 focus:ring-2 focus:ring-amber-400/40 disabled:cursor-not-allowed disabled:opacity-40";

const deliveryInputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-500 hover:border-slate-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-400/40 disabled:cursor-not-allowed disabled:opacity-40";

/** Input dos dados de contato do recebimento online (Asaas). */
const contactInputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-500 hover:border-slate-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-400/40 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Assinatura vazia para `useSyncExternalStore`: a origem do site só existe no
 * cliente, então o servidor renderiza `""` e a hidratação não diverge.
 */
const subscribeToNothing = () => () => {};

interface DeliveryFormState {
  delivery_type: DeliveryType;
  delivery_fee: string;
  distance_base_km: string;
  distance_base_fee: string;
  distance_extra_km_fee: string;
  max_delivery_radius_km: string;
  /** Endereço da loja por extenso (origem do cálculo do frete). */
  store_address: string;
  estimated_delivery_time_min: string;
  estimated_delivery_time_max: string;
}

interface StoreLocationState {
  latitude: number;
  longitude: number;
  /** Endereço (chave normalizada) que originou estas coordenadas. */
  address: string;
  /** Endereço completo devolvido pela API de geocodificação. */
  label: string;
  /**
   * Procedência das coordenadas: `api` quando vieram de uma consulta feita
   * nesta sessão (`/api/geocode`) e `saved` quando foram apenas carregadas da
   * base (`store_latitude`/`store_longitude` já persistidos).
   */
  source: "api" | "saved";
}

const EMPTY_DELIVERY_FORM: DeliveryFormState = {
  delivery_type: "fixed",
  delivery_fee: "0",
  distance_base_km: "3",
  distance_base_fee: "0",
  distance_extra_km_fee: "0",
  max_delivery_radius_km: "",
  store_address: "",
  estimated_delivery_time_min: String(DEFAULT_ESTIMATED_DELIVERY_TIME_MIN),
  estimated_delivery_time_max: String(DEFAULT_ESTIMATED_DELIVERY_TIME_MAX),
};

/** Valor numérico legível em input (vírgula decimal, sem zeros inúteis). */
function numberInputValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
}

/**
 * Chave de comparação do endereço da loja: espaços colapsados + minúsculas.
 * Usada para saber se as coordenadas em memória correspondem ao texto atual.
 */
function normalizeStoreAddressKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Espera após o último caractere digitado no endereço antes de consultar a API
 * de geocodificação. Evita uma chamada por tecla enquanto o lojista digita.
 */
const STORE_ADDRESS_LOOKUP_DEBOUNCE_MS = 1000;

/**
 * O texto já parece um endereço completo o suficiente para consultar sozinho?
 *
 * Exige um número (rua + número) e um mínimo de caracteres — assim a API não é
 * chamada enquanto o lojista ainda digita só o nome da rua. O botão "Buscar
 * localização" força a consulta em qualquer momento.
 */
function isLikelyCompleteStoreAddress(value: string): boolean {
  const address = value.replace(/\s+/g, " ").trim();
  return address.length >= 10 && /\d/.test(address);
}

/**
 * Monta o formulário de recebimento online a partir da linha do estabelecimento.
 *
 * Prefere o snapshot salvo em `asaas_subaccount` e, na primeira conexão, usa
 * tudo o que o cadastro da loja já sabe: responsável/razão social, documento,
 * e-mail, telefone (contato ou WhatsApp oficial) e CEP. Logradouro e bairro são
 * completados depois pelo CEP (`/api/geocode`), porque `establishments` só
 * guarda o CEP da loja.
 */
function buildSubaccountFormFromRow(row: Establishment): AsaasSubaccountForm {
  const profile = row.asaas_subaccount ?? null;
  const rawDocument = profile?.cpfCnpj ?? row.document_number ?? "";
  const rawCep =
    profile?.postalCode ?? (row.store_cep != null ? String(row.store_cep) : "");
  // Telefone: snapshot → telefone de contato → WhatsApp oficial (normalmente é
  // o número mais atualizado da loja). O WhatsApp pode estar salvo com o DDI
  // 55; `formatWhatsAppPhoneForDisplay` devolve o formato nacional.
  const storePhone =
    row.phone?.trim() || formatWhatsAppPhoneForDisplay(row.whatsapp) || "";
  const rawPhone = profile?.phone ?? storePhone;
  return {
    name: profile?.name ?? (row.owner_name?.trim() || row.name || ""),
    cpfCnpj: rawDocument ? formatCpfCnpjInput(rawDocument) : "",
    email: profile?.email ?? row.email ?? "",
    phone: formatPhoneInput(rawPhone),
    incomeValue:
      profile?.incomeValue != null ? String(profile.incomeValue) : "",
    postalCode: formatPostalCodeInput(rawCep),
    address: profile?.address ?? "",
    addressNumber: profile?.addressNumber ?? "",
    complement: profile?.complement ?? "",
    province: profile?.province ?? "",
    companyType: profile?.companyType ?? "",
    birthDate: profile?.birthDate ?? "",
    pixKey: row.pix_key ?? "",
    acceptPixOnline: row.accept_pix_online === true,
  };
}

async function uploadToStorage(
  supabase: ReturnType<typeof createClient>,
  establishmentId: string,
  file: File,
): Promise<string> {
  const fileName = fileNameFor(file);
  const path = buildStoragePath(establishmentId, fileName);
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, { cacheControl: "3600" });
  if (error) throw new Error(error.message);
  const { data: { publicUrl } = {} } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  if (!publicUrl) throw new Error("URL pública não gerada pelo storage.");
  return publicUrl;
}

export default function ConfiguracoesIdentidade() {
  const { selectedId, isSuperAdmin, isLoading } = useEstablishment();
  const supabase = useMemo(() => createClient(), []);

  const [logo, setLogo] = useState<PreviewState>({ status: "idle" });
  const [banner, setBanner] = useState<PreviewState>({ status: "idle" });
  // Object URLs (`URL.createObjectURL`) criadas para as prévias — rastreadas
  // para poderem ser revogadas ao desmontar (evita vazamento de memória).
  const objectUrlsRef = useRef<Set<string>>(new Set());
  // Sequência por campo: se o lojista trocar a imagem no meio do processamento
  // (canvas) ou do upload, o resultado do arquivo antigo é descartado.
  const fileJobRef = useRef<{ logo_url: number; banner_url: number }>({
    logo_url: 0,
    banner_url: 0,
  });
  // Inputs nativos de arquivo (logo/banner). Ficam `sr-only` e são acionados
  // pelos botões customizados de upload via ref.
  const fileInputsRef = useRef<
    Record<"logo_url" | "banner_url", HTMLInputElement | null>
  >({ logo_url: null, banner_url: null });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [establishmentData, setEstablishmentData] = useState<Establishment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Formulário de dados públicos (nome + texto abaixo do nome).
  const [nameValue, setNameValue] = useState("");
  const [descriptionValue, setDescriptionValue] = useState("");
  const [isSavingInfo, setIsSavingInfo] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [infoSuccess, setInfoSuccess] = useState<string | null>(null);
  // Aviso não-crítico (ex.: coluna `description` pendente de migração).
  const [infoWarning, setInfoWarning] = useState<string | null>(null);

  // Horário de funcionamento (7 dias; chaves "0".."6").
  const [openingHours, setOpeningHours] = useState<OpeningHours>(() =>
    toEditableOpeningHours(null)
  );
  const [isSavingHours, setIsSavingHours] = useState(false);
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [hoursSuccess, setHoursSuccess] = useState<string | null>(null);

  // Entrega e frete (modelo fixo ou por distância + raio máximo).
  const [deliveryForm, setDeliveryForm] =
    useState<DeliveryFormState>(EMPTY_DELIVERY_FORM);
  const [storeLocation, setStoreLocation] =
    useState<StoreLocationState | null>(null);
  /**
   * Último endereço consultado na API de geocodificação (chave normalizada).
   * Impede que a busca automática repita a mesma chamada (inclusive após erro)
   * a cada render.
   */
  const lastStoreAddressRef = useRef<string | null>(null);
  /**
   * Sequência das consultas de localização. Descarta a resposta de um endereço
   * anterior que chegue depois de uma consulta mais recente (digitação rápida).
   */
  const storeLookupRequestRef = useRef(0);
  const [isSavingDelivery, setIsSavingDelivery] = useState(false);
  const [isGeocodingStore, setIsGeocodingStore] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliverySuccess, setDeliverySuccess] = useState<string | null>(null);
  const [deliveryWarning, setDeliveryWarning] = useState<string | null>(null);

  // Pedido mínimo do subtotal dos itens (migração 20261111000003).
  const [minOrderValue, setMinOrderValue] = useState("0,00");
  const [isSavingMinOrder, setIsSavingMinOrder] = useState(false);
  const [minOrderError, setMinOrderError] = useState<string | null>(null);
  const [minOrderSuccess, setMinOrderSuccess] = useState<string | null>(null);
  const [minOrderWarning, setMinOrderWarning] = useState<string | null>(null);

  // Vale-Refeição / Alimentação na entrega (migração 20261111000004):
  // bandeiras aceitas pela loja na maquininha presencial.
  const [mealVouchers, setMealVouchers] = useState<string[]>([]);
  const [customMealVoucher, setCustomMealVoucher] = useState("");
  const [isSavingMealVouchers, setIsSavingMealVouchers] = useState(false);
  const [mealVoucherError, setMealVoucherError] = useState<string | null>(null);
  const [mealVoucherSuccess, setMealVoucherSuccess] = useState<string | null>(
    null
  );
  const [mealVoucherWarning, setMealVoucherWarning] = useState<string | null>(
    null
  );

  // Pagamento online (Asaas Split) — dados de recebimento da subconta.
  const [subaccountForm, setSubaccountForm] = useState<AsaasSubaccountForm>(
    EMPTY_ASAAS_SUBACCOUNT_FORM
  );
  const [isSavingSubaccount, setIsSavingSubaccount] = useState(false);
  const [subaccountError, setSubaccountError] = useState<string | null>(null);
  const [subaccountSuccess, setSubaccountSuccess] = useState<string | null>(null);
  // Endereço da subconta: `establishments` guarda apenas o CEP da loja, então
  // logradouro/bairro são completados pela consulta de CEP (`/api/geocode`).
  const [subaccountCepStatus, setSubaccountCepStatus] = useState<
    "idle" | "loading" | "found" | "error"
  >("idle");
  const [subaccountCepMessage, setSubaccountCepMessage] = useState<
    string | null
  >(null);
  // Último CEP consultado — evita repetir a chamada externa a cada render.
  const lastSubaccountCepRef = useRef<string | null>(null);

  // Link público da loja: exibido apenas para leitura/cópia (o slug é definido
  // no cadastro do estabelecimento e não é editável por esta tela).
  const siteOrigin = useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => ""
  );
  const [storeLinkCopied, setStoreLinkCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!selectedId) return;

    // `select("*")` é tolerante a colunas ainda não migradas (description,
    // opening_hours etc.) — a tela continua abrindo em bases legadas.
    supabase
      .from("establishments")
      .select("*")
      .eq("id", selectedId)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          setLoadError("Não foi possível carregar os dados da loja selecionada.");
          return;
        }
        const row = data as Establishment;
        const settings = normalizeDeliverySettings(row);
        setEstablishmentData(row);
        setNameValue(row.name ?? "");
        setDescriptionValue(row.description ?? "");
        setOpeningHours(toEditableOpeningHours(row.opening_hours));
        setDeliveryForm({
          delivery_type: settings.delivery_type,
          delivery_fee: numberInputValue(settings.delivery_fee),
          distance_base_km: numberInputValue(settings.distance_base_km),
          distance_base_fee: numberInputValue(settings.distance_base_fee),
          distance_extra_km_fee: numberInputValue(
            settings.distance_extra_km_fee
          ),
          max_delivery_radius_km:
            settings.max_delivery_radius_km != null
              ? numberInputValue(settings.max_delivery_radius_km)
              : "",
          store_address: settings.store_address ?? "",
          estimated_delivery_time_min: numberInputValue(
            settings.estimated_delivery_time_min
          ),
          estimated_delivery_time_max: numberInputValue(
            settings.estimated_delivery_time_max
          ),
        });
        // Pedido mínimo (migração 20261111000003): bases legadas sem a coluna
        // caem em 0,00 (sem mínimo).
        setMinOrderValue(
          formatCurrencyValue(normalizeMinOrderValue(row.min_order_value))
        );
        // Vale-Refeição/Alimentação na entrega (migração 20261111000004):
        // base legada sem a coluna cai em lista vazia (não aceita vale).
        setMealVouchers(normalizeMealVouchers(row.accepted_meal_vouchers));
        setStoreLocation(
          settings.store_latitude != null && settings.store_longitude != null
            ? {
                latitude: settings.store_latitude,
                longitude: settings.store_longitude,
                address: normalizeStoreAddressKey(settings.store_address ?? ""),
                label:
                  settings.store_address ??
                  (settings.store_cep
                    ? `Origem salva · CEP ${formatCep(settings.store_cep)}`
                    : "Localização já cadastrada"),
                source: "saved",
              }
            : null
        );
        // Troca de loja: a busca automática pode consultar o endereço do novo
        // estabelecimento mesmo que seja o mesmo texto da loja anterior.
        lastStoreAddressRef.current = null;
        setLoadError(null);
        // Pagamento online: snapshot da subconta (ou preenchimento inicial com
        // os dados já conhecidos da loja).
        setSubaccountForm(buildSubaccountFormFromRow(row));
        // Troca de loja: reinicia a consulta de CEP (endereço recomeça vazio).
        setSubaccountCepStatus("idle");
        setSubaccountCepMessage(null);
        lastSubaccountCepRef.current = null;
      });
  }, [selectedId, supabase]);

  const setPreview = useCallback((field: "logo_url" | "banner_url", state: PreviewState) => {
    if (state.previewUrl) objectUrlsRef.current.add(state.previewUrl);
    const apply = field === "logo_url" ? setLogo : setBanner;
    apply((prev) => {
      // Revoga a object URL anterior quando ela for substituída ou removida
      // (senão cada arquivo selecionado ficaria retido em memória).
      if (prev.previewUrl && prev.previewUrl !== state.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      return state;
    });
  }, []);

  // Ao desmontar, libera todas as object URLs criadas para as prévias.
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  // Cancela o timer do aviso "Copiado!" ao desmontar a tela.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  // Slug público da loja — gerado no cadastro e exibido apenas para leitura.
  const storeSlug = establishmentData?.slug?.trim() ?? "";
  const storePath = storeSlug ? `/${storeSlug}` : "/";
  // Origem só existe no cliente; até a hidratação o link aparece relativo.
  const storeLink = siteOrigin ? `${siteOrigin}${storePath}` : storePath;

  // Pagamento online: documento (só dígitos) define PF/CNPJ para exibir os
  // campos exigidos pelo Asaas (data de nascimento x tipo de empresa).
  const subaccountDocumentDigits = subaccountForm.cpfCnpj.replace(/\D/g, "");
  const subaccountIsCompany = subaccountDocumentDigits.length === 14;
  const subaccountConnected = Boolean(establishmentData?.asaas_account_id);
  // CEP da subconta (somente dígitos) — usado pelo preenchimento do endereço.
  const subaccountCepDigits = parseCep(subaccountForm.postalCode) ?? "";
  // Situação exibida no título da seção (feedback imediato, sem rolar a tela).
  // Usa o toggle local para refletir a intenção do lojista antes de salvar.
  const onlinePaymentStatus = resolveOnlinePaymentStatus({
    hasSubaccount: subaccountConnected,
    acceptPixOnline: subaccountForm.acceptPixOnline,
  });

  /** Atualiza um campo do recebimento online e limpa os avisos da seção. */
  const updateSubaccountField = (patch: Partial<AsaasSubaccountForm>) => {
    setSubaccountForm((prev) => ({ ...prev, ...patch }));
    setSubaccountError(null);
    setSubaccountSuccess(null);
  };

  /**
   * Completa logradouro/bairro do recebimento online a partir do CEP salvo no
   * cadastro da loja (`/api/geocode` → BrasilAPI/ViaCEP). Nunca sobrescreve o
   * que o lojista já digitou e falha em silêncio: sem internet ou com CEP
   * desconhecido o formulário continua utilizável.
   */
  const fillSubaccountAddressFromCep = useCallback(
    async (rawCep: string, options?: { force?: boolean }) => {
      const force = options?.force === true;
      const cep = parseCep(rawCep);
      if (!cep) {
        if (force) {
          setSubaccountCepStatus("error");
          setSubaccountCepMessage(
            "Informe um CEP válido (8 dígitos) para buscar o endereço."
          );
        }
        return;
      }
      // Consulta automática: uma vez por CEP (o botão "força" nova tentativa).
      if (!force && lastSubaccountCepRef.current === cep) return;
      lastSubaccountCepRef.current = cep;

      setSubaccountCepStatus("loading");
      setSubaccountCepMessage(null);
      try {
        const res = await fetch(`/api/geocode?cep=${encodeURIComponent(cep)}`);
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          address?: {
            street?: string | null;
            neighborhood?: string | null;
            city?: string | null;
            state?: string | null;
          } | null;
        };
        if (!res.ok || !json.address) {
          throw new Error(json.error ?? "CEP não encontrado.");
        }

        const street = json.address.street?.trim() ?? "";
        const neighborhood = json.address.neighborhood?.trim() ?? "";
        const city = json.address.city?.trim() ?? "";
        const state = json.address.state?.trim() ?? "";

        if (!street && !neighborhood) {
          setSubaccountCepStatus("error");
          setSubaccountCepMessage(
            "CEP localizado, mas sem rua/bairro. Preencha o endereço manualmente."
          );
          return;
        }

        setSubaccountForm((prev) => ({
          ...prev,
          // Só completa os campos vazios (preserva edições do lojista).
          address: prev.address.trim() ? prev.address : street,
          province: prev.province.trim() ? prev.province : neighborhood,
        }));
        setSubaccountCepStatus("found");
        const location = [street, neighborhood, city, state]
          .filter((part) => part !== "")
          .join(", ");
        setSubaccountCepMessage(
          `Endereço do CEP ${formatCep(cep)}${location ? `: ${location}` : ""}. Confira o número.`
        );
      } catch (err) {
        setSubaccountCepStatus("error");
        setSubaccountCepMessage(
          err instanceof Error
            ? err.message
            : "Não foi possível buscar o endereço deste CEP."
        );
      }
    },
    []
  );

  // Preenchimento automático ao abrir a seção: se o CEP já veio do cadastro da
  // loja e a rua/bairro ainda estão vazios, completa sem o lojista digitar.
  // A consulta roda em um microtask (fora do corpo do efeito) para não disparar
  // renders em cascata — regra `react-hooks/set-state-in-effect`.
  useEffect(() => {
    if (!selectedId) return;
    if (subaccountCepDigits.length !== 8) return;
    if (subaccountForm.address.trim() && subaccountForm.province.trim()) return;
    void Promise.resolve().then(() =>
      fillSubaccountAddressFromCep(subaccountCepDigits)
    );
  }, [
    selectedId,
    subaccountCepDigits,
    subaccountForm.address,
    subaccountForm.province,
    fillSubaccountAddressFromCep,
  ]);

  /**
   * Copia o link público da loja para a área de transferência. O endereço é
   * somente informativo: o slug não pode ser alterado por esta tela.
   */
  const handleCopyStoreLink = useCallback(async () => {
    const url = siteOrigin ? `${siteOrigin}${storePath}` : storePath;
    try {
      await navigator.clipboard.writeText(url);
      setStoreLinkCopied(true);
      if (copyTimerRef.current != null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(
        () => setStoreLinkCopied(false),
        2000
      );
    } catch {
      // Navegadores sem Clipboard API (ex.: contexto não seguro).
    }
  }, [siteOrigin, storePath]);

  const clearPreview = useCallback((field: "logo_url" | "banner_url") => {
    setPreview(field, { status: "idle" });
  }, [setPreview]);

  const handleFile = useCallback(
    async (field: "logo_url" | "banner_url", file: File) => {
      if (!selectedId) return;
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
        setPreview(field, { status: "idle", error: "Formato não suportado. Use PNG, JPG ou WebP." });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setPreview(field, { status: "idle", error: "Máximo de 20 MB." });
        return;
      }

      const preset = IMAGE_PRESETS[field];
      const jobId = ++fileJobRef.current[field];
      /** `true` quando outro arquivo foi escolhido depois deste. */
      const isStale = () => fileJobRef.current[field] !== jobId;

      // Etapa 1 — Canvas: recorta na proporção do preset (1:1 na logo, 3:1 no
      // banner) e converte para WebP 85%. Nada é enviado ao Storage ainda.
      setPreview(field, {
        status: "processing",
        fileName: file.name,
        fileSize: file.size,
        originalSize: file.size,
      });

      let optimized: ResizedImage;
      try {
        optimized = await resizeAndCropToWebP(file, {
          ...preset,
          fileName: field === "logo_url" ? "logo" : "banner",
        });
      } catch (err) {
        if (isStale()) return;
        setPreview(field, {
          status: "idle",
          error:
            err instanceof Error ? err.message : "Falha ao processar a imagem.",
        });
        return;
      }
      if (isStale()) return;

      // Etapa 2 — prévia do resultado já otimizado (object URL do WebP gerado,
      // não do arquivo original) e envio do arquivo final ao Storage.
      const previewUrl = URL.createObjectURL(optimized.blob);
      const optimizedMeta = {
        previewUrl,
        fileName: optimized.file.name,
        fileSize: optimized.file.size,
        originalSize: file.size,
        width: optimized.width,
        height: optimized.height,
      };
      setPreview(field, { status: "uploading", ...optimizedMeta });

      try {
        const url = await uploadToStorage(supabase, selectedId, optimized.file);
        if (isStale()) {
          URL.revokeObjectURL(previewUrl);
          return;
        }
        setPreview(field, { status: "stored", url, ...optimizedMeta });
      } catch (err) {
        if (isStale()) {
          URL.revokeObjectURL(previewUrl);
          return;
        }
        // Falha no upload → descarta a prévia (setPreview revoga a object URL)
        // e volta para a imagem salva, exibindo o erro abaixo do input.
        setPreview(field, {
          status: "idle",
          error: err instanceof Error ? err.message : "Falha no upload.",
        });
      }
    },
    [selectedId, supabase, setPreview],
  );

  const handleSave = useCallback(async () => {
    if (!selectedId) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const body: { establishment_id: string; logo_url?: string; banner_url?: string } = {
        establishment_id: selectedId,
      };
      if (logo.status === "stored") body.logo_url = logo.url;
      if (banner.status === "stored") body.banner_url = banner.url;
      if (Object.keys(body).length === 0) {
        setSaveError("Selecione ao menos uma imagem para salvar.");
        return;
      }
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(json.error ?? "Falha ao salvar as configurações.");
      setSaveSuccess("Identidade visual salva.");
      const { data } = await supabase.from("establishments").select("logo_url, banner_url").eq("id", selectedId).single();
      // Merge (não substitui) para não descartar name/description já carregados.
      // O select evita `description` de propósito: essa consulta é só das imagens
      // e não deve quebrar se a coluna ainda não existir na base (migração 07).
      // As URLs recém-salvas entram de forma otimista para o badge já apontar
      // para a imagem nova mesmo se o re-SELECT falhar.
      setEstablishmentData((prev) => ({
        ...(prev ?? (data as Establishment)),
        ...(data as Establishment),
        ...(body.logo_url !== undefined ? { logo_url: body.logo_url } : {}),
        ...(body.banner_url !== undefined ? { banner_url: body.banner_url } : {}),
      }));
      // Imagens persistidas: descarta as prévias locais (revoga as object URLs)
      // e volta o badge para "Atual" — as URLs novas já estão em establishmentData.
      if (logo.status === "stored") setPreview("logo_url", { status: "idle" });
      if (banner.status === "stored") setPreview("banner_url", { status: "idle" });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsSaving(false);
    }
  }, [selectedId, supabase, logo, banner, setPreview]);

  const hasStored = logo.status === "stored" || banner.status === "stored";

  /**
   * Salva nome + descrição/slogan via PUT /api/establishment. Os campos são
   * enviados juntos (mesmo endpoint da identidade visual) e refletem na
   * vitrine pública no próximo carregamento — /api/menu não usa cache.
   */
  const handleSaveInfo = useCallback(async () => {
    if (!selectedId) return;
    const name = nameValue.trim();
    if (!name) {
      setInfoError("Informe o nome do estabelecimento.");
      return;
    }
    setIsSavingInfo(true);
    setInfoError(null);
    setInfoSuccess(null);
    setInfoWarning(null);
    try {
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          name,
          description: descriptionValue.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Falha ao salvar os dados da loja.");

      // Aviso não-crítico devolvido pela API (ex.: coluna `description`
      // pendente de migração — nesse caso só `name` foi persistido).
      const warning =
        typeof json.warning === "string" && json.warning ? json.warning : null;
      setInfoWarning(warning);

      // Espelha o retorno da API no estado local (description pode vir null).
      const saved = json.establishment as Establishment | undefined;
      if (saved) {
        setEstablishmentData((prev) => ({ ...(prev ?? saved), ...saved }));
        setNameValue(saved.name ?? name);
        // Só sobrescreve o textarea quando a API retornou a coluna — se ela
        // não existe na base, preserva o texto digitado pelo usuário.
        if (saved.description !== undefined) {
          setDescriptionValue(saved.description ?? "");
        }
      }
      setInfoSuccess(
        warning
          ? "Nome salvo. A descrição será gravada após criar a coluna pendente."
          : "Dados da loja salvos. A vitrine já reflete a alteração."
      );
    } catch (err) {
      setInfoError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsSavingInfo(false);
    }
  }, [selectedId, nameValue, descriptionValue]);

  /**
   * Salva os horários de funcionamento via PUT /api/establishment.
   * A validação garante que dias ativos tenham abertura e fechamento.
   */
  const handleSaveHours = useCallback(async () => {
    if (!selectedId) return;

    for (const day of WEEKDAYS) {
      const value = openingHours[day.key];
      if (value?.enabled && (!value.open_time || !value.close_time)) {
        setHoursError(
          `Informe a abertura e o fechamento de ${day.label}.`
        );
        return;
      }
    }

    setIsSavingHours(true);
    setHoursError(null);
    setHoursSuccess(null);
    try {
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          opening_hours: openingHours,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "Falha ao salvar o horário de funcionamento.");
      }

      const saved = json.establishment as Establishment | undefined;
      if (saved) {
        setEstablishmentData((prev) => ({ ...(prev ?? saved), ...saved }));
        if (saved.opening_hours !== undefined) {
          setOpeningHours(toEditableOpeningHours(saved.opening_hours));
        }
      }
      setHoursSuccess(
        "Horário de funcionamento salvo. A vitrine já reflete a alteração."
      );
    } catch (err) {
      setHoursError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsSavingHours(false);
    }
  }, [selectedId, openingHours]);

  const updateDeliveryField = (field: keyof DeliveryFormState, value: string) => {
    setDeliveryForm((prev) => {
      const next = { ...prev };
      if (field === "delivery_type") {
        next.delivery_type = value === "distance" ? "distance" : "fixed";
      } else if (field === "store_address") {
        next.store_address = value.slice(0, STORE_ADDRESS_MAX_LENGTH);
      } else {
        next[field] = value;
      }
      return next;
    });
    if (field === "store_address") {
      // Endereço mudou: as coordenadas antigas não representam mais a origem.
      const key = normalizeStoreAddressKey(value);
      setStoreLocation((prev) => (prev && prev.address !== key ? null : prev));
      // Invalida consultas em andamento para o endereço anterior: a resposta
      // não deve preencher uma origem que já não corresponde ao campo.
      if (lastStoreAddressRef.current && lastStoreAddressRef.current !== key) {
        storeLookupRequestRef.current += 1;
        // Libera nova tentativa caso o lojista volte ao mesmo endereço.
        lastStoreAddressRef.current = null;
        setIsGeocodingStore(false);
      }
    }
    setDeliveryError(null);
    setDeliverySuccess(null);
    setDeliveryWarning(null);
  };

  /**
   * Consulta a API de endereços (`/api/geocode?address=...` → Nominatim) a
   * partir do endereço da loja digitado por extenso.
   *
   * O retorno é a fonte da verdade da origem do frete: o endereço formatado é
   * exibido abaixo do campo e `latitude`/`longitude` são guardadas para o
   * `PUT /api/establishment` gravar `store_latitude`/`store_longitude`.
   *
   * `force` ignora o controle de "uma consulta por endereço" (usado pelo botão
   * "Buscar localização" e pelo salvamento); a busca automática usa o padrão.
   */
  const lookupStoreLocation = useCallback(
    async (
      rawAddress: string,
      options?: { force?: boolean }
    ): Promise<StoreLocationState | null> => {
      const force = options?.force === true;
      const address = rawAddress.replace(/\s+/g, " ").trim();
      if (address.length < STORE_ADDRESS_MIN_LENGTH) {
        setDeliveryError(
          "Informe o endereço completo da loja (rua e número) para localizar a origem do frete."
        );
        return null;
      }
      const key = normalizeStoreAddressKey(address);
      // Busca automática: no máximo uma tentativa por endereço. O botão força
      // uma nova consulta (ex.: quando a API estava indisponível).
      if (!force && lastStoreAddressRef.current === key) return null;
      lastStoreAddressRef.current = key;

      // Cada consulta recebe um id: se outro endereço disparar uma busca
      // enquanto esta está em andamento, a resposta antiga é ignorada.
      const requestId = ++storeLookupRequestRef.current;

      setIsGeocodingStore(true);
      setDeliveryError(null);
      setDeliverySuccess(null);
      setDeliveryWarning(null);
      try {
        const res = await fetch(
          `/api/geocode?address=${encodeURIComponent(address)}`
        );
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          formatted_address?: string;
          address?: {
            street?: string | null;
            neighborhood?: string | null;
            city?: string | null;
            state?: string | null;
            cep?: string | null;
            latitude?: number | null;
            longitude?: number | null;
          };
        };
        if (requestId !== storeLookupRequestRef.current) return null;
        if (!res.ok || !json.address) {
          throw new Error(json.error ?? "Endereço não localizado.");
        }

        const latitude = toFiniteNumber(json.address.latitude);
        const longitude = toFiniteNumber(json.address.longitude);
        if (latitude == null || longitude == null) {
          throw new Error(
            "Não foi possível obter as coordenadas deste endereço. Confira rua e número e tente novamente."
          );
        }

        // Endereço validado pela API (rua, número · bairro · cidade/UF · CEP).
        // O texto serve de feedback para o lojista conferir a origem do frete.
        const city = json.address.city?.trim() ?? "";
        const state = json.address.state?.trim() ?? "";
        const label =
          json.formatted_address?.trim() ||
          [
            json.address.street,
            json.address.neighborhood,
            [city, state].filter((part) => part !== "").join("/"),
            json.address.cep ? `CEP ${formatCep(json.address.cep)}` : null,
          ]
            .filter((part): part is string => Boolean(part && part.trim()))
            .join(" · ");

        const location: StoreLocationState = {
          latitude,
          longitude,
          address: key,
          label,
          source: "api",
        };
        setStoreLocation(location);
        setDeliverySuccess(
          "Localização da loja confirmada pela API. Clique em “Salvar entrega” para aplicar."
        );
        return location;
      } catch (err) {
        if (requestId !== storeLookupRequestRef.current) return null;
        setDeliveryError(
          err instanceof Error
            ? err.message
            : "Não foi possível localizar o endereço da loja."
        );
        return null;
      } finally {
        // Só encerra o loading da consulta atual; uma busca mais recente ainda
        // em andamento continua exibindo "Consultando…".
        if (requestId === storeLookupRequestRef.current) {
          setIsGeocodingStore(false);
        }
      }
    },
    []
  );

  /** Botão “Buscar localização”: força uma nova consulta à API de endereços. */
  const handleLookupStoreAddress = () => {
    void lookupStoreLocation(deliveryForm.store_address, { force: true });
  };

  // Busca automática: quando o texto já tem rua + número a API é consultada sem
  // exigir clique. O botão continua disponível para forçar nova tentativa.
  useEffect(() => {
    if (!selectedId) return;
    const address = deliveryForm.store_address.replace(/\s+/g, " ").trim();
    if (!isLikelyCompleteStoreAddress(address)) return;
    const key = normalizeStoreAddressKey(address);
    if (storeLocation?.address === key) return;
    if (lastStoreAddressRef.current === key) return;

    const timer = setTimeout(() => {
      void lookupStoreLocation(address);
    }, STORE_ADDRESS_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    deliveryForm.store_address,
    lookupStoreLocation,
    selectedId,
    storeLocation?.address,
  ]);

  /** Salva modelo de frete, taxas, raio e origem via PUT /api/establishment. */
  const handleSaveDelivery = async () => {
    if (!selectedId) return;

    const deliveryType = deliveryForm.delivery_type;
    const deliveryFee = toFiniteNumber(deliveryForm.delivery_fee);
    const baseKm = toFiniteNumber(deliveryForm.distance_base_km);
    const baseFee = toFiniteNumber(deliveryForm.distance_base_fee);
    const extraKmFee = toFiniteNumber(deliveryForm.distance_extra_km_fee);
    const radiusRaw = deliveryForm.max_delivery_radius_km.trim();
    const radius = radiusRaw ? toFiniteNumber(radiusRaw) : null;
    const storeAddress = deliveryForm.store_address.replace(/\s+/g, " ").trim();
    const storeAddressKey = normalizeStoreAddressKey(storeAddress);
    const estimatedMin = toFiniteNumber(
      deliveryForm.estimated_delivery_time_min
    );
    const estimatedMax = toFiniteNumber(
      deliveryForm.estimated_delivery_time_max
    );

    if (deliveryFee == null || deliveryFee < 0) {
      setDeliveryError("Informe uma taxa fixa de entrega válida.");
      return;
    }
    if (deliveryType === "distance") {
      if (baseKm == null || baseKm <= 0) {
        setDeliveryError("A distância base deve ser maior que zero.");
        return;
      }
      if (baseFee == null || baseFee < 0) {
        setDeliveryError("Informe uma taxa base válida.");
        return;
      }
      if (extraKmFee == null || extraKmFee < 0) {
        setDeliveryError("Informe um valor por km excedente válido.");
        return;
      }
    }
    if (radiusRaw && (radius == null || radius <= 0)) {
      setDeliveryError(
        "O raio máximo deve ser maior que zero ou ficar vazio (sem limite)."
      );
      return;
    }
    if (storeAddress && storeAddress.length < STORE_ADDRESS_MIN_LENGTH) {
      setDeliveryError(
        `Informe o endereço da loja com rua e número (mínimo ${STORE_ADDRESS_MIN_LENGTH} caracteres).`
      );
      return;
    }
    if (isGeocodingStore) {
      setDeliveryError(
        "Aguarde a consulta de localização da API de endereços terminar antes de salvar."
      );
      return;
    }
    if (
      estimatedMin == null ||
      !Number.isInteger(estimatedMin) ||
      estimatedMin < MIN_ESTIMATED_DELIVERY_MINUTES ||
      estimatedMin > MAX_ESTIMATED_DELIVERY_MINUTES
    ) {
      setDeliveryError(
        `O tempo mínimo de entrega deve ser um número inteiro entre ${MIN_ESTIMATED_DELIVERY_MINUTES} e ${MAX_ESTIMATED_DELIVERY_MINUTES} minutos.`
      );
      return;
    }
    if (
      estimatedMax == null ||
      !Number.isInteger(estimatedMax) ||
      estimatedMax < estimatedMin ||
      estimatedMax > MAX_ESTIMATED_DELIVERY_MINUTES
    ) {
      setDeliveryError(
        "O tempo máximo de entrega deve ser um número inteiro maior ou igual ao mínimo e no máximo 600 minutos."
      );
      return;
    }

    // Endereço ainda não confirmado nesta sessão (o lojista digitou e clicou
    // direto em salvar): geocodifica agora, como o botão faria. A gravação
    // abaixo usa exatamente as coordenadas devolvidas pela API.
    // Loja legada com coordenadas salvas e sem endereço no campo mantém a
    // origem já validada (o campo vazio não deve apagar `store_latitude`).
    let location =
      storeLocation &&
      (storeAddressKey === "" || storeLocation.address === storeAddressKey)
        ? storeLocation
        : null;
    if (!location && storeAddress) {
      location = await lookupStoreLocation(storeAddress, { force: true });
      if (!location) return; // mensagem de erro já exibida abaixo do campo
    }
    if ((deliveryType === "distance" || radius != null) && !location) {
      setDeliveryError(
        "Informe o endereço da loja (rua e número) para calcular a entrega por distância."
      );
      return;
    }

    setIsSavingDelivery(true);
    setDeliveryError(null);
    setDeliverySuccess(null);
    setDeliveryWarning(null);
    try {
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          delivery_type: deliveryType,
          delivery_fee: deliveryFee,
          distance_base_km: baseKm ?? 3,
          distance_base_fee: baseFee ?? 0,
          distance_extra_km_fee: extraKmFee ?? 0,
          max_delivery_radius_km: radius,
          store_address: storeAddress || null,
          // Origem do frete: exatamente as coordenadas devolvidas pela API de
          // geocodificação (ou as já persistidas e exibidas no formulário).
          store_latitude: location?.latitude ?? null,
          store_longitude: location?.longitude ?? null,
          estimated_delivery_time_min: estimatedMin,
          estimated_delivery_time_max: estimatedMax,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warning?: string;
        establishment?: Establishment;
      };
      if (!res.ok) {
        throw new Error(
          json.error ?? "Falha ao salvar as configurações de entrega."
        );
      }

      const warning =
        typeof json.warning === "string" && json.warning ? json.warning : null;
      setDeliveryWarning(warning);
      const saved = json.establishment;
      if (saved) {
        setEstablishmentData((prev) => ({ ...(prev ?? saved), ...saved }));

        // Reflete no formulário exatamente o que ficou gravado no banco — a
        // origem do frete passa a ser esse par de coordenadas, sem recálculo
        // local. Se a gravação devolveu coordenadas vazias (endereço removido),
        // o estado acompanha para não exibir uma origem que não existe mais.
        const savedLatitude = toFiniteNumber(saved.store_latitude);
        const savedLongitude = toFiniteNumber(saved.store_longitude);
        const savedAddress =
          normalizeStoreAddress(saved.store_address) ?? storeAddress;
        if (savedLatitude != null && savedLongitude != null) {
          setStoreLocation({
            latitude: savedLatitude,
            longitude: savedLongitude,
            address: normalizeStoreAddressKey(savedAddress),
            label:
              location?.label || savedAddress || "Localização cadastrada",
            source: location?.source ?? "saved",
          });
        } else {
          setStoreLocation(null);
        }
      }
      setDeliverySuccess(
        warning
          ? "Configurações de entrega salvas parcialmente."
          : "Configurações de entrega salvas. O checkout já usa as novas regras."
      );
    } catch (err) {
      setDeliveryError(
        err instanceof Error ? err.message : "Erro inesperado ao salvar."
      );
    } finally {
      setIsSavingDelivery(false);
    }
  };

  /**
   * Salva o pedido mínimo do subtotal dos itens (migração 20261111000003).
   * `0,00` desativa a exigência — a loja volta a aceitar qualquer valor.
   */
  const handleSaveMinOrder = async () => {
    if (!selectedId) return;

    const parsed = parseCurrencyInput(minOrderValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setMinOrderError(
        "Informe um valor de pedido mínimo válido (zero ou mais)."
      );
      return;
    }

    setIsSavingMinOrder(true);
    setMinOrderError(null);
    setMinOrderSuccess(null);
    setMinOrderWarning(null);
    try {
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          min_order_value: parsed,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warning?: string;
        establishment?: Establishment;
      };
      if (!res.ok) {
        throw new Error(json.error ?? "Falha ao salvar o pedido mínimo.");
      }

      const warning =
        typeof json.warning === "string" && json.warning ? json.warning : null;
      setMinOrderWarning(warning);

      // A API devolve o valor gravado; sem ele, mantém o que foi enviado.
      const savedValue = normalizeMinOrderValue(
        json.establishment?.min_order_value ?? parsed
      );
      setMinOrderValue(formatCurrencyValue(savedValue));
      if (json.establishment) {
        const saved = json.establishment;
        setEstablishmentData((prev) => ({ ...(prev ?? saved), ...saved }));
      }

      setMinOrderSuccess(
        warning
          ? "Pedido mínimo salvo parcialmente."
          : savedValue > 0
            ? `Pedido mínimo salvo (R$ ${formatCurrencyValue(
                savedValue
              )}). A vitrine, a sacola e o checkout já usam a regra.`
            : "Pedido mínimo desativado — a loja aceita qualquer valor."
      );
    } catch (err) {
      setMinOrderError(
        err instanceof Error ? err.message : "Erro inesperado ao salvar."
      );
    } finally {
      setIsSavingMinOrder(false);
    }
  };

  /**
   * Marca/desmarca uma bandeira de vale na lista local. O salvamento só
   * acontece no botão "Salvar bandeiras" (mesmo padrão das demais seções).
   */
  const toggleMealVoucher = (voucher: string) => {
    const alreadySelected = mealVouchers.some(
      (item) => item.toLowerCase() === voucher.toLowerCase()
    );
    if (!alreadySelected && mealVouchers.length >= MAX_MEAL_VOUCHERS) {
      setMealVoucherError(
        `Cadastre no máximo ${MAX_MEAL_VOUCHERS} bandeiras de vale.`
      );
      return;
    }

    setMealVoucherError(null);
    setMealVoucherSuccess(null);
    setMealVoucherWarning(null);
    setMealVouchers((prev) =>
      alreadySelected
        ? prev.filter((item) => item.toLowerCase() !== voucher.toLowerCase())
        : [...prev, voucher]
    );
  };

  /** Remove uma bandeira da lista (usado pelas customizadas e pelos chips). */
  const removeMealVoucher = (voucher: string) => {
    setMealVoucherError(null);
    setMealVoucherSuccess(null);
    setMealVoucherWarning(null);
    setMealVouchers((prev) =>
      prev.filter((item) => item.toLowerCase() !== voucher.toLowerCase())
    );
  };

  /** Adiciona uma bandeira customizada (ex.: vale da própria região). */
  const handleAddCustomMealVoucher = () => {
    setMealVoucherError(null);
    setMealVoucherSuccess(null);
    setMealVoucherWarning(null);

    const name = normalizeMealVoucherName(customMealVoucher);
    if (!name) {
      setMealVoucherError("Informe o nome da bandeira que deseja adicionar.");
      return;
    }
    if (customMealVoucher.trim().length > MAX_MEAL_VOUCHER_NAME_LENGTH) {
      setMealVoucherError(
        `O nome da bandeira deve ter até ${MAX_MEAL_VOUCHER_NAME_LENGTH} caracteres.`
      );
      return;
    }
    if (
      mealVouchers.some((item) => item.toLowerCase() === name.toLowerCase())
    ) {
      setMealVoucherError(`A bandeira "${name}" já está na lista.`);
      return;
    }
    if (mealVouchers.length >= MAX_MEAL_VOUCHERS) {
      setMealVoucherError(
        `Cadastre no máximo ${MAX_MEAL_VOUCHERS} bandeiras de vale.`
      );
      return;
    }

    setMealVouchers((prev) => [...prev, name]);
    setCustomMealVoucher("");
  };

  /**
   * Salva as bandeiras de vale-refeição/alimentação aceitas NA ENTREGA
   * (migração 20261111000004). É cobrança presencial na maquininha — nunca
   * passa pelo pagamento online/gateway.
   */
  const handleSaveMealVouchers = async () => {
    if (!selectedId) return;

    setIsSavingMealVouchers(true);
    setMealVoucherError(null);
    setMealVoucherSuccess(null);
    setMealVoucherWarning(null);
    try {
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          accepted_meal_vouchers: mealVouchers,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warning?: string;
        establishment?: Establishment;
      };
      if (!res.ok) {
        throw new Error(
          json.error ?? "Falha ao salvar as bandeiras de vale."
        );
      }

      const warning =
        typeof json.warning === "string" && json.warning ? json.warning : null;
      setMealVoucherWarning(warning);

      const saved = normalizeMealVouchers(
        json.establishment?.accepted_meal_vouchers ?? mealVouchers
      );
      setMealVouchers(saved);
      const savedEstablishment = json.establishment;
      if (savedEstablishment) {
        setEstablishmentData((prev) => ({
          ...(prev ?? savedEstablishment),
          ...savedEstablishment,
        }));
      }

      setMealVoucherSuccess(
        warning
          ? "Bandeiras salvas parcialmente."
          : saved.length > 0
            ? `Bandeiras salvas (${saved.length}). O checkout já mostra "Vale-Refeição / Alimentação" na entrega.`
            : "Vale-refeição desativado — a opção não aparece mais no checkout."
      );
    } catch (err) {
      setMealVoucherError(
        err instanceof Error ? err.message : "Erro inesperado ao salvar."
      );
    } finally {
      setIsSavingMealVouchers(false);
    }
  };

  /**
   * Conecta/atualiza o recebimento online (Asaas Split). Na primeira conexão a
   * rota cria a subconta e guarda o `asaas_account_id`; depois atualiza a chave
   * PIX de resgate e a preferência de "Aceitar PIX Online".
   */
  const handleSaveSubaccount = async () => {
    if (!selectedId) return;

    setSubaccountError(null);
    setSubaccountSuccess(null);

    const validation = validateAsaasSubaccountForm(subaccountForm);
    if (!validation.ok) {
      setSubaccountError(validation.error);
      return;
    }

    setIsSavingSubaccount(true);
    try {
      const res = await fetch("/api/asaas/subaccount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          ...subaccountForm,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        notice?: string | null;
        updated?: boolean;
        establishment?: Partial<Establishment>;
        /** Diagnóstico do Asaas devolvido em falhas (401/403). */
        code?: string | null;
        asaas_status?: number;
        asaas_environment?: string;
        details?: unknown;
      };
      if (!res.ok) {
        // Detalhes completos no console do navegador — mostram se o 403 é API
        // key inválida, ambiente divergente (sandbox × produção) ou permissão.
        console.error("[configuracoes] o Asaas recusou a operação", json);
        throw new Error(json.error ?? "Falha ao conectar o pagamento online.");
      }

      const saved = json.establishment;
      if (saved) {
        setEstablishmentData((prev) => (prev ? { ...prev, ...saved } : prev));
      }

      setSubaccountSuccess(
        json.notice ??
          (json.updated
            ? "Dados de recebimento atualizados."
            : "Subconta conectada com sucesso! O PIX online já pode ser ativado.")
      );
    } catch (err) {
      setSubaccountError(
        err instanceof Error ? err.message : "Erro inesperado ao salvar."
      );
    } finally {
      setIsSavingSubaccount(false);
    }
  };

  // Bandeiras fora da lista padrão (customizadas) já selecionadas pela loja.
  const customMealVouchers = mealVouchers.filter(
    (voucher) =>
      !MEAL_VOUCHER_OPTIONS.some(
        (option) => option.toLowerCase() === voucher.toLowerCase()
      )
  );

  return (
    <div className="flex flex-1 flex-col">
      <AdminHeader
        establishmentId={selectedId}
        isSuperAdmin={isSuperAdmin}
        badge={
          saveSuccess ? (
            <span className="rounded-full bg-green-100 px-3 py-1.5 text-sm font-semibold text-green-700">
              {saveSuccess}
            </span>
          ) : null
        }
      />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
          </div>
        )}

        {/* Dados públicos da loja (nome, descrição e link exibidos na vitrine) */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 className="font-semibold text-slate-900">Dados da Loja</h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Nome, texto e link exibidos no cardápio público. O link abaixo é
            apenas informativo — ele é gerado no cadastro e não pode ser
            alterado por aqui.
          </p>

          <div className="mt-4 flex flex-col gap-4">
            {/* Link público: somente leitura + cópia (o slug não é editável). */}
            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                Link da loja
              </span>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  readOnly
                  value={storeLink}
                  aria-label="Link público da loja (somente leitura)"
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full cursor-text rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600 outline-none focus:border-slate-300"
                />
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyStoreLink()}
                    className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                  >
                    {storeLinkCopied ? "Copiado!" : "Copiar"}
                  </button>
                  <a
                    href={storePath}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-slate-300 px-3 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                  >
                    Abrir
                  </a>
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Endereço fixo do cardápio — não é possível editar o slug.
              </p>
            </div>

            <div>
              <label
                htmlFor="store-name"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Nome do estabelecimento
              </label>
              <input
                id="store-name"
                type="text"
                value={nameValue}
                onChange={(e) => {
                  setNameValue(e.target.value);
                  setInfoSuccess(null);
                  setInfoWarning(null);
                }}
                maxLength={80}
                placeholder="Ex.: Burger Gourmet"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-500 hover:border-slate-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-400/40"
              />
              <p className="mt-1 text-xs text-slate-500">
                {nameValue.trim().length}/80 caracteres
              </p>
            </div>

            <div>
              <label
                htmlFor="store-description"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Texto abaixo do nome (descrição / slogan)
              </label>
              <textarea
                id="store-description"
                value={descriptionValue}
                onChange={(e) => {
                  setDescriptionValue(e.target.value);
                  setInfoSuccess(null);
                  setInfoWarning(null);
                }}
                rows={2}
                maxLength={200}
                placeholder="Ex.: Artesanal na brasa · Entrega em 30 min"
                className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-500 hover:border-slate-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-400/40"
              />
              <p className="mt-1 text-xs text-slate-500">
                Deixe vazio para exibir o selo “Pedidos online” padrão.{" "}
                {descriptionValue.trim().length}/200 caracteres
              </p>
            </div>
          </div>

          {infoError && <p className="mt-3 text-sm text-red-600">{infoError}</p>}
          {infoSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {infoSuccess}
            </p>
          )}
          {infoWarning && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
              {infoWarning}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleSaveInfo}
              disabled={isSavingInfo || !selectedId || !nameValue.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingInfo ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar dados da loja"
              )}
            </button>
          </div>
        </section>

        {/* Horário de funcionamento (aberto/fechado na vitrine + validação na API) */}
        <section
          aria-labelledby="opening-hours-title"
          className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 id="opening-hours-title" className="font-semibold text-slate-900">
              Horário de Funcionamento
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Ative os dias em que a loja abre e informe a abertura/fechamento.
            Fora desses horários a vitrine exibe &quot;Fechado no momento&quot; e
            os pedidos são bloqueados.
          </p>

          <div className="mt-4 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200">
            {WEEKDAYS.map((day) => {
              const value = openingHours[day.key] ?? {
                enabled: false,
                open_time: DEFAULT_OPEN_TIME,
                close_time: DEFAULT_CLOSE_TIME,
              };
              const enabledId = `hours-${day.key}-enabled`;
              const openId = `hours-${day.key}-open`;
              const closeId = `hours-${day.key}-close`;

              return (
                <div
                  key={day.key}
                  className="flex flex-col gap-3 bg-slate-50 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <label
                    htmlFor={enabledId}
                    className="flex cursor-pointer items-center gap-3"
                  >
                    <input
                      id={enabledId}
                      type="checkbox"
                      checked={value.enabled}
                      onChange={(e) => {
                        setOpeningHours((prev) => ({
                          ...prev,
                          [day.key]: {
                            ...value,
                            enabled: e.target.checked,
                          },
                        }));
                        setHoursSuccess(null);
                      }}
                      className="h-4 w-4 cursor-pointer rounded border-slate-300 bg-white accent-yellow-400 focus:ring-2 focus:ring-amber-400/40"
                    />
                    <span
                      className={`text-sm font-medium ${
                        value.enabled ? "text-slate-800" : "text-slate-500"
                      }`}
                    >
                      {day.label}
                    </span>
                  </label>

                  <div
                    className={`flex flex-wrap items-center gap-2 ${
                      value.enabled ? "" : "opacity-40"
                    }`}
                  >
                    <label htmlFor={openId} className="sr-only">
                      Abertura de {day.label}
                    </label>
                    <input
                      id={openId}
                      type="time"
                      value={value.open_time}
                      disabled={!value.enabled}
                      onChange={(e) => {
                        setOpeningHours((prev) => ({
                          ...prev,
                          [day.key]: { ...value, open_time: e.target.value },
                        }));
                        setHoursSuccess(null);
                      }}
                      className={timeInputClass}
                    />
                    <span className="text-xs font-medium text-slate-500">às</span>
                    <label htmlFor={closeId} className="sr-only">
                      Fechamento de {day.label}
                    </label>
                    <input
                      id={closeId}
                      type="time"
                      value={value.close_time}
                      disabled={!value.enabled}
                      onChange={(e) => {
                        setOpeningHours((prev) => ({
                          ...prev,
                          [day.key]: { ...value, close_time: e.target.value },
                        }));
                        setHoursSuccess(null);
                      }}
                      className={timeInputClass}
                    />
                    {!value.enabled && (
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        Fechado
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-2 text-xs text-slate-500">
            Fechamento menor que a abertura indica virada de noite (ex.: 18:00 às
            02:00). Horários iguais significam funcionamento 24h naquele dia.
          </p>

          {hoursError && <p className="mt-3 text-sm text-red-600">{hoursError}</p>}
          {hoursSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {hoursSuccess}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleSaveHours}
              disabled={isSavingHours || !selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingHours ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar horários"
              )}
            </button>
          </div>
        </section>

        {/* Entrega e frete: modelo fixo/por distância, raio e origem (endereço
            da loja geocodificado pela API → lat/long persistidas) */}
        <section
          aria-labelledby="delivery-title"
          className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 id="delivery-title" className="font-semibold text-slate-900">
              Entrega e Frete
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Defina como a taxa de entrega é calculada. No modelo por distância, a
            taxa base vale até a distância inclusa e cada km excedente é cobrado
            pelo valor adicional. O raio máximo vale para os dois modelos e o
            checkout bloqueia endereços fora dele.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="delivery-type"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Modelo de entrega
              </label>
              <select
                id="delivery-type"
                value={deliveryForm.delivery_type}
                onChange={(e) =>
                  updateDeliveryField("delivery_type", e.target.value)
                }
                className={deliveryInputClass}
              >
                <option value="fixed">Taxa fixa</option>
                <option value="distance">Por distância (km)</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="delivery-fee"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                {deliveryForm.delivery_type === "distance"
                  ? "Taxa fixa de fallback (R$)"
                  : "Taxa fixa de entrega (R$)"}
              </label>
              <input
                id="delivery-fee"
                type="text"
                inputMode="decimal"
                value={deliveryForm.delivery_fee}
                onChange={(e) =>
                  updateDeliveryField("delivery_fee", e.target.value)
                }
                placeholder="0,00"
                className={deliveryInputClass}
              />
              <p className="mt-1 text-xs text-slate-500">
                {deliveryForm.delivery_type === "distance"
                  ? "Usada quando não for possível calcular a distância até o cliente."
                  : "Valor cobrado em todos os pedidos de entrega."}
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Previsão de entrega
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Janela informada ao cliente no rastreio do pedido. O horário previsto
              é calculado a partir do tempo máximo.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="estimated-delivery-min"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Tempo mínimo (min)
                </label>
                <input
                  id="estimated-delivery-min"
                  type="number"
                  inputMode="numeric"
                  min={MIN_ESTIMATED_DELIVERY_MINUTES}
                  max={MAX_ESTIMATED_DELIVERY_MINUTES}
                  step={1}
                  value={deliveryForm.estimated_delivery_time_min}
                  onChange={(e) =>
                    updateDeliveryField(
                      "estimated_delivery_time_min",
                      e.target.value
                    )
                  }
                  placeholder={String(DEFAULT_ESTIMATED_DELIVERY_TIME_MIN)}
                  className={deliveryInputClass}
                />
              </div>
              <div>
                <label
                  htmlFor="estimated-delivery-max"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Tempo máximo (min)
                </label>
                <input
                  id="estimated-delivery-max"
                  type="number"
                  inputMode="numeric"
                  min={MIN_ESTIMATED_DELIVERY_MINUTES}
                  max={MAX_ESTIMATED_DELIVERY_MINUTES}
                  step={1}
                  value={deliveryForm.estimated_delivery_time_max}
                  onChange={(e) =>
                    updateDeliveryField(
                      "estimated_delivery_time_max",
                      e.target.value
                    )
                  }
                  placeholder={String(DEFAULT_ESTIMATED_DELIVERY_TIME_MAX)}
                  className={deliveryInputClass}
                />
              </div>
            </div>
          </div>



          {deliveryForm.delivery_type === "distance" && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">
                Cálculo por distância
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="distance-base-km"
                    className="mb-1.5 block text-sm font-medium text-slate-700"
                  >
                    Distância inclusa (km)
                  </label>
                  <input
                    id="distance-base-km"
                    type="text"
                    inputMode="decimal"
                    value={deliveryForm.distance_base_km}
                    onChange={(e) =>
                      updateDeliveryField("distance_base_km", e.target.value)
                    }
                    placeholder="3"
                    className={deliveryInputClass}
                  />
                </div>
                <div>
                  <label
                    htmlFor="distance-base-fee"
                    className="mb-1.5 block text-sm font-medium text-slate-700"
                  >
                    Taxa base (R$)
                  </label>
                  <input
                    id="distance-base-fee"
                    type="text"
                    inputMode="decimal"
                    value={deliveryForm.distance_base_fee}
                    onChange={(e) =>
                      updateDeliveryField("distance_base_fee", e.target.value)
                    }
                    placeholder="0,00"
                    className={deliveryInputClass}
                  />
                </div>
                <div>
                  <label
                    htmlFor="distance-extra-km-fee"
                    className="mb-1.5 block text-sm font-medium text-slate-700"
                  >
                    Valor por km excedente (R$)
                  </label>
                  <input
                    id="distance-extra-km-fee"
                    type="text"
                    inputMode="decimal"
                    value={deliveryForm.distance_extra_km_fee}
                    onChange={(e) =>
                      updateDeliveryField("distance_extra_km_fee", e.target.value)
                    }
                    placeholder="0,00"
                    className={deliveryInputClass}
                  />
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Exemplo: base de 3 km por R$ 5,00 + R$ 1,50/km excedente. Um pedido
                a 5 km custa R$ 8,00.
              </p>
            </div>
          )}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="max-delivery-radius"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Raio máximo de entrega (km)
              </label>
              <input
                id="max-delivery-radius"
                type="text"
                inputMode="decimal"
                value={deliveryForm.max_delivery_radius_km}
                onChange={(e) =>
                  updateDeliveryField("max_delivery_radius_km", e.target.value)
                }
                placeholder="Sem limite"
                className={deliveryInputClass}
              />
              <p className="mt-1 text-xs text-slate-500">
                Deixe vazio para não limitar. Endereços além do raio são
                bloqueados no checkout.
              </p>
            </div>

            <div>
              <label
                htmlFor="store-address"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Endereço da Loja (ex: Av. Bady Bassitt, 1500 - Centro)
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="store-address"
                  type="text"
                  autoComplete="off"
                  maxLength={STORE_ADDRESS_MAX_LENGTH}
                  value={deliveryForm.store_address}
                  onChange={(e) =>
                    updateDeliveryField("store_address", e.target.value)
                  }
                  placeholder="Av. Bady Bassitt, 1500 - Centro, São José do Rio Preto - SP"
                  className={deliveryInputClass}
                />
                <button
                  type="button"
                  onClick={handleLookupStoreAddress}
                  disabled={isGeocodingStore || isSavingDelivery || !selectedId}
                  className="shrink-0 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-600 transition hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400/40 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isGeocodingStore
                    ? "Buscando..."
                    : storeLocation
                      ? "Buscar novamente"
                      : "Buscar localização"}
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Digite rua e número (e, se possível, bairro e cidade). Com o
                número no texto, a localização é buscada automaticamente na API
                de endereços; o botão força uma nova consulta.
              </p>
              {isGeocodingStore ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                  <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                  Consultando a API de endereços…
                </p>
              ) : storeLocation ? (
                <div className="mt-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 text-xs leading-relaxed text-green-700">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                    {storeLocation.source === "api"
                      ? "Localização confirmada pela API"
                      : "Localização salva da loja"}
                  </p>
                  <p className="mt-1">{storeLocation.label}</p>
                  <p className="mt-1 font-mono text-[11px] text-green-800/90">
                    Latitude {storeLocation.latitude.toFixed(6)} · Longitude{" "}
                    {storeLocation.longitude.toFixed(6)}
                  </p>
                  <p className="mt-1 text-[11px] text-green-700/80">
                    Estas coordenadas são o ponto de partida do cálculo de frete
                    por km.
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-xs text-amber-600">
                  Informe o endereço completo da loja (rua e número) — as
                  coordenadas retornadas pela API são necessárias para calcular
                  a distância até o cliente.
                </p>
              )}
            </div>
          </div>

          {deliveryError && (
            <p className="mt-3 text-sm text-red-600">{deliveryError}</p>
          )}
          {deliverySuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {deliverySuccess}
            </p>
          )}
          {deliveryWarning && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
              {deliveryWarning}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveDelivery()}
              disabled={isSavingDelivery || isGeocodingStore || !selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingDelivery ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar entrega"
              )}
            </button>
          </div>
        </section>

        {/* Pedido mínimo do subtotal dos itens (migração 20261111000003) */}
        <section
          aria-labelledby="min-order-title"
          className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 id="min-order-title" className="font-semibold text-slate-900">
              Pedido mínimo
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Valor mínimo em produtos (sem a taxa de entrega) para o cliente
            finalizar o pedido. Abaixo desse valor a sacola e o checkout mostram
            quanto falta e bloqueiam o avanço. Use 0,00 para não exigir mínimo.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="min-order-value"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Valor mínimo do pedido (R$)
              </label>
              <input
                id="min-order-value"
                type="text"
                inputMode="decimal"
                value={minOrderValue}
                onChange={(e) => {
                  setMinOrderValue(formatCurrencyInput(e.target.value));
                  setMinOrderError(null);
                  setMinOrderSuccess(null);
                  setMinOrderWarning(null);
                }}
                placeholder="0,00"
                className={deliveryInputClass}
              />
              <p className="mt-1 text-xs text-slate-500">
                A comparação usa o subtotal dos itens (antes do frete). 0,00 =
                sem pedido mínimo.
              </p>
            </div>
          </div>

          {minOrderError && (
            <p className="mt-3 text-sm text-red-600">{minOrderError}</p>
          )}
          {minOrderSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {minOrderSuccess}
            </p>
          )}
          {minOrderWarning && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
              {minOrderWarning}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveMinOrder()}
              disabled={isSavingMinOrder || !selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingMinOrder ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar pedido mínimo"
              )}
            </button>
          </div>
        </section>

        {/* Vale-Refeição / Alimentação na entrega (migração 20261111000004) */}
        <section
          aria-labelledby="meal-voucher-title"
          className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 id="meal-voucher-title" className="font-semibold text-slate-900">
              Vale-Refeição / Alimentação (Pagamento na entrega)
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Marque as bandeiras que sua loja aceita cobrar{" "}
            <strong>presencialmente na entrega</strong> (maquininha). O cliente
            escolhe a bandeira no checkout e o entregador leva a maquininha
            correspondente.
          </p>
          <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            Esta opção é exclusiva para cobrança presencial na entrega — o
            pagamento <strong>não</strong> passa pelo sistema (não usa PIX
            Online/gateway).
          </p>

          <fieldset className="mt-4">
            <legend className="mb-2 block text-sm font-medium text-slate-700">
              Bandeiras aceitas na entrega
            </legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {MEAL_VOUCHER_OPTIONS.map((option) => {
                const checked = mealVouchers.some(
                  (voucher) => voucher.toLowerCase() === option.toLowerCase()
                );
                return (
                  <label
                    key={option}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition ${
                      checked
                        ? "border-yellow-400 bg-yellow-50 text-slate-900"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMealVoucher(option)}
                      className="h-4 w-4 accent-yellow-500"
                    />
                    <span className="font-medium">{option}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {customMealVouchers.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Outras bandeiras cadastradas
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {customMealVouchers.map((voucher) => (
                  <span
                    key={voucher}
                    className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800"
                  >
                    {voucher}
                    <button
                      type="button"
                      onClick={() => removeMealVoucher(voucher)}
                      aria-label={`Remover a bandeira ${voucher}`}
                      className="text-amber-700 transition hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label
                htmlFor="custom-meal-voucher"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Outra bandeira (opcional)
              </label>
              <input
                id="custom-meal-voucher"
                type="text"
                value={customMealVoucher}
                maxLength={MAX_MEAL_VOUCHER_NAME_LENGTH}
                onChange={(e) => {
                  setCustomMealVoucher(e.target.value);
                  setMealVoucherError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  handleAddCustomMealVoucher();
                }}
                placeholder="Ex.: Vale Local"
                className={deliveryInputClass}
              />
            </div>
            <button
              type="button"
              onClick={handleAddCustomMealVoucher}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
            >
              Adicionar
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Sem nenhuma bandeira marcada a opção &quot;Vale-Refeição /
            Alimentação&quot; não aparece no checkout.
          </p>

          {mealVoucherError && (
            <p className="mt-3 text-sm text-red-600">{mealVoucherError}</p>
          )}
          {mealVoucherSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {mealVoucherSuccess}
            </p>
          )}
          {mealVoucherWarning && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
              {mealVoucherWarning}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveMealVouchers()}
              disabled={isSavingMealVouchers || !selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingMealVouchers ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar bandeiras"
              )}
            </button>
          </div>
        </section>

        {/* Pagamento Online / Financeiro — Split de Pagamentos (Asaas) */}
        <section
          aria-labelledby="online-payment-title"
          className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2
              id="online-payment-title"
              className="font-semibold text-slate-900"
            >
              Pagamento Online / Financeiro
            </h2>
            {/*
             * Situação sempre visível ao lado do título: o lojista sabe se o
             * PIX online está ativo sem precisar rolar até o fim da seção.
             * Reflete também o toggle local (feedback imediato ao ligar/desligar).
             */}
            <span
              role="status"
              aria-live="polite"
              title={onlinePaymentStatus.description}
              className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${ONLINE_PAYMENT_STATUS_BADGE_CLASSES[onlinePaymentStatus.tone]}`}
            >
              <span aria-hidden="true">{onlinePaymentStatus.emoji}</span>
              {onlinePaymentStatus.label}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-600">
            {onlinePaymentStatus.description}
          </p>

          {/* Aviso transparente de taxas (plataforma + gateway) */}
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-800">
            <p className="font-semibold text-amber-900">
              Como funcionam as taxas do pagamento online
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>
                <strong>Taxa da plataforma:</strong> {PLATFORM_FEE_LABEL} por
                pedido pago online, retida automaticamente do repasse. O restante
                cai direto na sua conta de recebimento.
              </li>
              <li>
                <strong>Taxa do gateway (Asaas):</strong> a taxa de processamento
                do PIX é definida pelo seu contrato com o Asaas e é descontada
                por ele no momento do recebimento.
              </li>
              <li>
                Nada é cobrado enquanto o recebimento online estiver desligado.
              </li>
            </ul>
          </div>

          <p className="mt-3 text-xs text-slate-600">
            Preencha os dados do titular da conta que vai receber os repasses.
            Usamos essas informações para criar a sua conta de recebimento no
            Asaas (subconta) e conectar o PIX online ao cardápio.
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            Os campos abaixo já vêm preenchidos com os dados da sua loja (nome,
            documento, e-mail, telefone e CEP) — revise e edite somente o que
            precisar.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="asaas-name" className="mb-1.5 block text-sm font-medium text-slate-700">
                Razão social / Nome completo
              </label>
              <input
                id="asaas-name"
                type="text"
                autoComplete="name"
                maxLength={120}
                value={subaccountForm.name}
                onChange={(e) => updateSubaccountField({ name: e.target.value })}
                placeholder="Ex.: Burger Gourmet Ltda / Maria da Silva"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-document" className="mb-1.5 block text-sm font-medium text-slate-700">
                CPF / CNPJ
              </label>
              <input
                id="asaas-document"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={18}
                value={subaccountForm.cpfCnpj}
                onChange={(e) =>
                  updateSubaccountField({ cpfCnpj: formatCpfCnpjInput(e.target.value) })
                }
                placeholder="000.000.000-00 ou 00.000.000/0000-00"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-email" className="mb-1.5 block text-sm font-medium text-slate-700">
                E-mail
              </label>
              <input
                id="asaas-email"
                type="email"
                autoComplete="email"
                maxLength={120}
                value={subaccountForm.email}
                onChange={(e) => updateSubaccountField({ email: e.target.value })}
                placeholder="financeiro@sualoja.com.br"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-phone" className="mb-1.5 block text-sm font-medium text-slate-700">
                Telefone / Celular
              </label>
              <input
                id="asaas-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
                value={subaccountForm.phone}
                onChange={(e) =>
                  updateSubaccountField({ phone: formatPhoneInput(e.target.value) })
                }
                placeholder="(17) 99999-9999"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-income" className="mb-1.5 block text-sm font-medium text-slate-700">
                Faturamento / Renda mensal (R$)
              </label>
              <input
                id="asaas-income"
                type="text"
                inputMode="decimal"
                value={subaccountForm.incomeValue}
                onChange={(e) => updateSubaccountField({ incomeValue: e.target.value })}
                placeholder="Ex.: 5000"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-cep" className="mb-1.5 block text-sm font-medium text-slate-700">
                CEP
              </label>
              <input
                id="asaas-cep"
                type="text"
                inputMode="numeric"
                autoComplete="postal-code"
                maxLength={9}
                value={subaccountForm.postalCode}
                onChange={(e) => {
                  const postalCode = formatPostalCodeInput(e.target.value);
                  updateSubaccountField({ postalCode });
                  // Ao completar os 8 dígitos, completa rua/bairro automaticamente.
                  const cep = parseCep(postalCode);
                  if (cep) void fillSubaccountAddressFromCep(cep);
                }}
                placeholder="00000-000"
                aria-describedby={
                  subaccountCepMessage ? "asaas-cep-message" : undefined
                }
                className={contactInputClass}
              />
              <button
                type="button"
                onClick={() =>
                  void fillSubaccountAddressFromCep(subaccountForm.postalCode, {
                    force: true,
                  })
                }
                disabled={subaccountCepStatus === "loading"}
                className="mt-1 text-xs font-semibold text-amber-700 underline-offset-2 transition hover:text-amber-800 hover:underline focus:outline-none focus:ring-2 focus:ring-amber-400/40 disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
              >
                {subaccountCepStatus === "loading"
                  ? "Buscando endereço..."
                  : "Buscar endereço pelo CEP"}
              </button>
              {subaccountCepMessage && (
                <p
                  id="asaas-cep-message"
                  role="status"
                  aria-live="polite"
                  className={`mt-1 text-xs leading-relaxed ${
                    subaccountCepStatus === "error"
                      ? "text-amber-700"
                      : "text-slate-500"
                  }`}
                >
                  {subaccountCepMessage}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="asaas-address" className="mb-1.5 block text-sm font-medium text-slate-700">
                Endereço (rua/avenida)
              </label>
              <input
                id="asaas-address"
                type="text"
                autoComplete="address-line1"
                maxLength={120}
                value={subaccountForm.address}
                onChange={(e) => updateSubaccountField({ address: e.target.value })}
                placeholder="Rua das Flores"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-address-number" className="mb-1.5 block text-sm font-medium text-slate-700">
                Número
              </label>
              <input
                id="asaas-address-number"
                type="text"
                maxLength={12}
                value={subaccountForm.addressNumber}
                onChange={(e) => updateSubaccountField({ addressNumber: e.target.value })}
                placeholder="123"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-complement" className="mb-1.5 block text-sm font-medium text-slate-700">
                Complemento (opcional)
              </label>
              <input
                id="asaas-complement"
                type="text"
                maxLength={60}
                value={subaccountForm.complement}
                onChange={(e) => updateSubaccountField({ complement: e.target.value })}
                placeholder="Sala 2 / Bloco B"
                className={contactInputClass}
              />
            </div>
            <div>
              <label htmlFor="asaas-province" className="mb-1.5 block text-sm font-medium text-slate-700">
                Bairro
              </label>
              <input
                id="asaas-province"
                type="text"
                maxLength={60}
                value={subaccountForm.province}
                onChange={(e) => updateSubaccountField({ province: e.target.value })}
                placeholder="Centro"
                className={contactInputClass}
              />
            </div>
            {subaccountIsCompany ? (
              <div>
                <label htmlFor="asaas-company-type" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Tipo de empresa
                </label>
                <select
                  id="asaas-company-type"
                  value={subaccountForm.companyType}
                  onChange={(e) =>
                    updateSubaccountField({
                      companyType: isAsaasCompanyType(e.target.value)
                        ? e.target.value
                        : "",
                    })
                  }
                  className={contactInputClass}
                >
                  <option value="">Selecione…</option>
                  {ASAAS_COMPANY_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {ASAAS_COMPANY_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label htmlFor="asaas-birthdate" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Data de nascimento (titular)
                </label>
                <input
                  id="asaas-birthdate"
                  type="date"
                  value={subaccountForm.birthDate}
                  onChange={(e) => updateSubaccountField({ birthDate: e.target.value })}
                  className={contactInputClass}
                />
              </div>
            )}
            <div className="sm:col-span-2">
              <label htmlFor="asaas-pix-key" className="mb-1.5 block text-sm font-medium text-slate-700">
                Chave PIX de resgate
              </label>
              <input
                id="asaas-pix-key"
                type="text"
                maxLength={120}
                value={subaccountForm.pixKey}
                onChange={(e) => updateSubaccountField({ pixKey: e.target.value })}
                placeholder="E-mail, telefone, CPF/CNPJ ou chave aleatória"
                aria-describedby="asaas-pix-key-hint"
                className={contactInputClass}
              />
              <p id="asaas-pix-key-hint" className="mt-1 text-xs text-slate-500">
                Chave usada pela plataforma para repassar os valores dos pedidos.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p id="accept-pix-label" className="text-sm font-medium text-slate-800">
                Aceitar PIX Online no cardápio
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Quando ligado, o cliente paga o pedido via PIX no checkout e o
                repasse cai na sua conta de recebimento (menos as taxas).
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={subaccountForm.acceptPixOnline}
              aria-labelledby="accept-pix-label"
              onClick={() =>
                updateSubaccountField({
                  acceptPixOnline: !subaccountForm.acceptPixOnline,
                })
              }
              disabled={!selectedId || isSavingSubaccount}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-amber-400/40 disabled:cursor-not-allowed disabled:opacity-60 ${
                subaccountForm.acceptPixOnline ? "bg-yellow-400" : "bg-slate-200"
              }`}
            >
              <span className="sr-only">
                {subaccountForm.acceptPixOnline ? "Desativar" : "Ativar"} PIX online
              </span>
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  subaccountForm.acceptPixOnline ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {establishmentData && establishmentData.asaas_account_id === undefined && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
              As colunas de pagamento online ainda não existem no banco. Execute a
              migração{" "}
              <code>20261110000027_add_asaas_subaccount_to_establishments.sql</code>{" "}
              no SQL Editor do Supabase para conectar o recebimento online.
            </p>
          )}

          {subaccountError && (
            <p className="mt-3 text-sm text-red-600">{subaccountError}</p>
          )}
          {subaccountSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-600">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {subaccountSuccess}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveSubaccount()}
              disabled={isSavingSubaccount || !selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingSubaccount ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />
                  Salvando...
                </>
              ) : subaccountConnected ? (
                "Salvar recebimento online"
              ) : (
                "Conectar recebimento online"
              )}
            </button>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {VISUAL_FIELDS.map((field) => {
            const isLogo = field.key === "logo_url";
            const state = isLogo ? logo : banner;
            const currentUrl = isLogo ? establishmentData?.logo_url : establishmentData?.banner_url;
            const isUploading = state.status === "uploading";
            const isProcessing = state.status === "processing";
            // Enquanto o canvas trabalha ou o arquivo sobe, o card fica travado.
            const isBusy = isUploading || isProcessing;
            const preset = IMAGE_PRESETS[field.key];
            // "Alterar imagem" quando já existe imagem salva ou prévia local.
            const hasImage = Boolean(state.previewUrl ?? currentUrl);
            return (
              <section key={field.key} className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <div className="flex items-center gap-2">
                  <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
                  <h2 className="font-semibold text-slate-900">{field.label}</h2>
                </div>
                <div className="mt-4 relative h-44 w-full overflow-hidden rounded-xl border border-slate-200 bg-white">
                  {/*
                   * Três estados: processando no canvas (indicador dedicado),
                   * prévia (arquivo novo tem prioridade sobre a imagem salva) e
                   * estado vazio elegante.
                   */}
                  {(() => {
                    if (isProcessing) {
                      return (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-slate-50 px-4 text-center">
                          <span
                            aria-hidden="true"
                            className="h-6 w-6 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
                          />
                          <p
                            role="status"
                            aria-live="polite"
                            className="text-xs font-medium text-slate-700"
                          >
                            Processando imagem...
                          </p>
                          <p className="text-[11px] leading-relaxed text-slate-500">
                            Recortando em {preset.width} × {preset.height} px e
                            convertendo para WebP
                          </p>
                        </div>
                      );
                    }

                    const previewSrc = state.previewUrl ?? currentUrl ?? null;
                    const hasNewPreview = Boolean(state.previewUrl);
                    return previewSrc ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={previewSrc}
                          alt={hasNewPreview ? `Prévia de ${field.label}` : field.label}
                          className="h-full w-full object-contain"
                        />
                        {hasNewPreview ? (
                          <div className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-yellow-400 px-2.5 py-1 text-[11px] font-semibold text-slate-950 shadow-md">
                            <span className="h-1.5 w-1.5 rounded-full bg-white" />
                            Novo · não salvo
                          </div>
                        ) : (
                          <div className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-slate-900 ring-1 ring-white/10">
                            <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                            Atual
                          </div>
                        )}
                        {isUploading && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-50/95">
                            <span
                              aria-hidden="true"
                              className="h-6 w-6 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
                            />
                            <p className="text-[11px] font-medium text-slate-600">
                              Enviando imagem...
                            </p>
                          </div>
                        )}
                      </>
                    ) : (
                      /* Estado vazio elegante: ícone discreto + texto auxiliar. */
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
                        <span className="rounded-xl border border-dashed border-slate-300 bg-white p-3">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                            aria-hidden="true"
                            className="h-6 w-6 text-slate-500"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
                            />
                          </svg>
                        </span>
                        <p className="text-sm font-medium text-slate-500">{field.emptyText}</p>
                        <p className="text-xs text-slate-500">{field.hint}</p>
                      </div>
                    );
                  })()}
                </div>

                {/*
                 * Área de upload: o input nativo fica `sr-only` (funcional e
                 * acessível) e é acionado pelo botão customizado via ref.
                 */}
                <div className="mt-4">
                  <div className="flex flex-col gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-3 transition hover:border-amber-400 hover:bg-amber-50/40 focus-within:border-amber-400 focus-within:bg-amber-50/40 focus-within:ring-2 focus-within:ring-amber-100 sm:flex-row sm:items-center">
                    <input
                      ref={(el) => {
                        fileInputsRef.current[field.key] = el;
                      }}
                      id={`upload-${field.key}`}
                      type="file"
                      accept={ACCEPT_ATTR}
                      aria-label={`Selecionar imagem para ${field.label.toLowerCase()}`}
                      tabIndex={-1}
                      disabled={isBusy || !selectedId}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // Zera o input para permitir reselecionar o mesmo arquivo.
                        e.target.value = "";
                        if (file) void handleFile(field.key, file);
                      }}
                      className="sr-only"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputsRef.current[field.key]?.click()}
                      disabled={isBusy || !selectedId}
                      aria-busy={isBusy}
                      className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-sm shadow-yellow-400/30 transition hover:bg-yellow-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                    >
                      {isBusy ? (
                        <span
                          aria-hidden="true"
                          className="h-4 w-4 animate-spin rounded-full border-2 border-slate-900/25 border-t-slate-900"
                        />
                      ) : (
                        /* Ícone de upload (traço, no estilo Lucide `Upload`). */
                        <svg
                          aria-hidden="true"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          viewBox="0 0 24 24"
                          className="h-4 w-4"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15.5v2.25A2.25 2.25 0 0 0 6.25 20h11.5A2.25 2.25 0 0 0 20 17.75V15.5"
                          />
                        </svg>
                      )}
                      {isProcessing
                        ? "Processando..."
                        : isUploading
                          ? "Enviando..."
                          : hasImage
                            ? "Alterar imagem"
                            : "Selecionar imagem"}
                    </button>

                    <div className="min-w-0 sm:flex-1">
                      {state.fileName ? (
                        <div className="min-w-0 space-y-1">
                          <p
                            className="flex min-w-0 items-center gap-1.5 text-xs"
                            title={state.fileName}
                          >
                            <svg
                              aria-hidden="true"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={1.75}
                              viewBox="0 0 24 24"
                              className="h-4 w-4 shrink-0 text-slate-400"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M14 3v4a1 1 0 0 0 1 1h4M15 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7l-3-4Z"
                              />
                            </svg>
                            <span className="min-w-0 truncate font-medium text-slate-700">
                              {state.fileName}
                            </span>
                            {typeof state.fileSize === "number" && (
                              <span className="shrink-0 text-slate-500">
                                · {formatFileSize(state.fileSize)}
                              </span>
                            )}
                          </p>
                          {/* Resultado do canvas: proporção final + ganho de peso. */}
                          {state.status === "processing" ? (
                            <p className="text-[11px] leading-relaxed text-slate-500">
                              Processando imagem...
                            </p>
                          ) : (
                            typeof state.width === "number" &&
                            typeof state.height === "number" && (
                              <p className="text-[11px] leading-relaxed text-slate-500">
                                Otimizada · {state.width} × {state.height} px ·
                                WebP 85%
                                {typeof state.originalSize === "number" &&
                                state.originalSize > 0 &&
                                typeof state.fileSize === "number" &&
                                state.fileSize < state.originalSize
                                  ? ` · ${formatFileSize(state.originalSize)} → ${formatFileSize(state.fileSize)}`
                                  : ""}
                              </p>
                            )
                          )}
                        </div>
                      ) : (
                        <p className="text-xs leading-relaxed text-slate-500">
                          {field.hint} · PNG, JPG ou WebP · até 20 MB · recorte e
                          conversão para WebP automáticos
                        </p>
                      )}
                    </div>
                  </div>

                  {state.error && <p className="mt-1.5 text-xs text-red-600">{state.error}</p>}
                  {state.status === "stored" && state.url && (
                    <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-green-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                      Pronto. Clique em{" "}
                      <button type="button" className="font-semibold text-amber-600 hover:underline" onClick={() => clearPreview(field.key)}>
                        retirar
                      </button>{" "}
                      e salvar.
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        {loadError && <p className="text-sm text-red-600">{loadError}</p>}
        {saveError && <p className="text-sm text-red-600">{saveError}</p>}

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasStored || isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? (<><span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-transparent" />Salvando...</>) : ("Salvar alterações")}
          </button>
        </div>
      </main>
    </div>
  );
}
