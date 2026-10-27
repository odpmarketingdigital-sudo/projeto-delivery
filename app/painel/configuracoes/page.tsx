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
  parseCep,
  toFiniteNumber,
  type DeliveryType,
} from "@/lib/delivery";
import {
  DEFAULT_ESTIMATED_DELIVERY_TIME_MAX,
  DEFAULT_ESTIMATED_DELIVERY_TIME_MIN,
  MAX_ESTIMATED_DELIVERY_MINUTES,
  MIN_ESTIMATED_DELIVERY_MINUTES,
} from "@/lib/deliveryEstimate";
import { formatWhatsAppPhoneForDisplay } from "@/lib/whatsappOrder";

const STORAGE_BUCKET = "products";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const ACCEPT_ATTR = ACCEPTED_IMAGE_TYPES.join(",");
const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "webp"]);

interface PreviewState {
  status: "idle" | "uploading" | "stored";
  url?: string;
  /**
   * Object URL (`URL.createObjectURL`) do arquivo selecionado — usada para
   * exibir a prévia instantânea antes (e durante) o upload para o Storage.
   * Revogada quando substituída, removida ou ao desmontar o componente.
   */
  previewUrl?: string;
  error?: string;
}

const VISUAL_FIELDS: {
  key: "logo_url" | "banner_url";
  label: string;
  hint: string;
  /** Texto exibido no estado vazio (quando não há imagem salva nem preview). */
  emptyText: string;
}[] = [
  { key: "logo_url", label: "Logo do estabelecimento", hint: "450 × 450 px (quadrada)", emptyText: "Nenhuma logo definida" },
  { key: "banner_url", label: "Banner/cover da loja", hint: "1000 × 480 px (retângulo)", emptyText: "Nenhum banner definido" },
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
 * Estilo compartilhado dos inputs de horário (`type="time"`).
 * `[color-scheme:dark]` mantém o seletor nativo legível no tema escuro.
 */
const timeInputClass =
  "w-[7.5rem] rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none transition [color-scheme:dark] focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/30 disabled:cursor-not-allowed disabled:opacity-40";

const deliveryInputClass =
  "w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 hover:border-gray-600 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/30 disabled:cursor-not-allowed disabled:opacity-40";

/** Input do telefone/WhatsApp da loja (contato usado no checkout). */
const contactInputClass =
  "w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 hover:border-gray-600 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/30 disabled:cursor-not-allowed disabled:opacity-40";

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
  store_cep: string;
  estimated_delivery_time_min: string;
  estimated_delivery_time_max: string;
}

interface StoreLocationState {
  latitude: number;
  longitude: number;
  /** CEP (somente dígitos) que originou estas coordenadas. */
  cep: string;
  label: string;
}

const EMPTY_DELIVERY_FORM: DeliveryFormState = {
  delivery_type: "fixed",
  delivery_fee: "0",
  distance_base_km: "3",
  distance_base_fee: "0",
  distance_extra_km_fee: "0",
  max_delivery_radius_km: "",
  store_cep: "",
  estimated_delivery_time_min: String(DEFAULT_ESTIMATED_DELIVERY_TIME_MIN),
  estimated_delivery_time_max: String(DEFAULT_ESTIMATED_DELIVERY_TIME_MAX),
};

/** Valor numérico legível em input (vírgula decimal, sem zeros inúteis). */
function numberInputValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
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
  const [isSavingDelivery, setIsSavingDelivery] = useState(false);
  const [isGeocodingStore, setIsGeocodingStore] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliverySuccess, setDeliverySuccess] = useState<string | null>(null);
  const [deliveryWarning, setDeliveryWarning] = useState<string | null>(null);

  // Envio do resumo do pedido para o WhatsApp da loja (migração 16).
  // Default `true` — mesma regra de `isWhatsAppCheckoutEnabled`.
  const [whatsappCheckoutEnabled, setWhatsappCheckoutEnabled] = useState(true);
  // Telefone/WhatsApp da loja (coluna `whatsapp`) — editável pelo lojista.
  const [whatsappValue, setWhatsappValue] = useState("");
  const [isSavingWhatsApp, setIsSavingWhatsApp] = useState(false);
  const [whatsappError, setWhatsappError] = useState<string | null>(null);
  const [whatsappSuccess, setWhatsappSuccess] = useState<string | null>(null);
  const [whatsappWarning, setWhatsappWarning] = useState<string | null>(null);

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
          store_cep: formatCep(settings.store_cep ?? ""),
          estimated_delivery_time_min: numberInputValue(
            settings.estimated_delivery_time_min
          ),
          estimated_delivery_time_max: numberInputValue(
            settings.estimated_delivery_time_max
          ),
        });
        setStoreLocation(
          settings.store_latitude != null && settings.store_longitude != null
            ? {
                latitude: settings.store_latitude,
                longitude: settings.store_longitude,
                cep: settings.store_cep ?? "",
                label: settings.store_cep
                  ? `CEP ${formatCep(settings.store_cep)}`
                  : "Localização já cadastrada",
              }
            : null
        );
        setLoadError(null);
        // Migração 20261110000016: ausência da coluna = recurso ativo.
        setWhatsappCheckoutEnabled(row.whatsapp_checkout_enabled !== false);
        // Número usado pelo checkout: WhatsApp oficial com fallback ao telefone.
        setWhatsappValue(row.whatsapp ?? row.phone ?? "");
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

  // Prévia formatada do número digitado (`null` = vazio ou inválido).
  const whatsappPreview = formatWhatsAppPhoneForDisplay(whatsappValue);
  const whatsappInvalid = whatsappValue.trim() !== "" && !whatsappPreview;

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
      // Prévia instantânea: object URL local exibida no <img> imediatamente,
      // antes (e durante) o upload para o Storage.
      const previewUrl = URL.createObjectURL(file);
      setPreview(field, { status: "uploading", previewUrl });
      try {
        const url = await uploadToStorage(supabase, selectedId, file);
        setPreview(field, { status: "stored", url, previewUrl });
      } catch (err) {
        // Falha no upload → descarta a prévia (setPreview revoga a object URL)
        // e volta para a imagem salva, exibindo o erro abaixo do input.
        setPreview(field, { status: "idle", error: (err as Error).message ?? "Falha no upload." });
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
      } else if (field === "store_cep") {
        next.store_cep = formatCep(value);
      } else {
        next[field] = value;
      }
      return next;
    });
    if (field === "store_cep") {
      // CEP mudou: as coordenadas antigas não representam mais a origem.
      const digits = parseCep(value) ?? "";
      setStoreLocation((prev) => (prev && prev.cep !== digits ? null : prev));
    }
    setDeliveryError(null);
    setDeliverySuccess(null);
    setDeliveryWarning(null);
  };

  /** Geocodifica o CEP da loja e guarda as coordenadas de origem do frete. */
  const handleLookupStoreCep = async () => {
    const cep = parseCep(deliveryForm.store_cep);
    if (!cep) {
      setDeliveryError("Informe um CEP válido com 8 dígitos para a loja.");
      return;
    }

    setIsGeocodingStore(true);
    setDeliveryError(null);
    setDeliverySuccess(null);
    setDeliveryWarning(null);
    try {
      const res = await fetch(`/api/geocode?cep=${encodeURIComponent(cep)}`);
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        address?: {
          street?: string | null;
          neighborhood?: string | null;
          city?: string | null;
          state?: string | null;
          latitude?: number | null;
          longitude?: number | null;
        };
      };
      if (!res.ok || !json.address) {
        throw new Error(json.error ?? "CEP não encontrado.");
      }

      const latitude = toFiniteNumber(json.address.latitude);
      const longitude = toFiniteNumber(json.address.longitude);
      if (latitude == null || longitude == null) {
        throw new Error(
          "Não foi possível obter as coordenadas deste CEP. Tente outro CEP."
        );
      }

      const label = [
        json.address.street,
        json.address.neighborhood,
        json.address.city,
        json.address.state,
      ]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(", ");

      setStoreLocation({
        latitude,
        longitude,
        cep,
        label: label || `CEP ${formatCep(cep)}`,
      });
      setDeliverySuccess(
        "Localização da loja encontrada. Clique em “Salvar entrega” para aplicar."
      );
    } catch (err) {
      setDeliveryError(
        err instanceof Error
          ? err.message
          : "Não foi possível localizar o CEP da loja."
      );
    } finally {
      setIsGeocodingStore(false);
    }
  };

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
    const storeCep = parseCep(deliveryForm.store_cep);
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
    if (deliveryForm.store_cep.trim() && !storeCep) {
      setDeliveryError("O CEP da loja deve ter 8 dígitos.");
      return;
    }
    if (deliveryType === "distance" && !storeCep) {
      setDeliveryError(
        "Informe o CEP da loja para calcular a entrega por distância."
      );
      return;
    }
    if ((deliveryType === "distance" || radius != null) && !storeLocation) {
      setDeliveryError(
        "Busque a localização da loja pelo CEP antes de salvar (necessária para calcular a distância)."
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
          store_cep: storeCep,
          store_latitude: storeLocation?.latitude ?? null,
          store_longitude: storeLocation?.longitude ?? null,
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
   * Salva o telefone/WhatsApp da loja junto da preferência de envio do resumo
   * no checkout. O número é o mesmo usado pelo botão do WhatsApp no checkout —
   * sem número válido o botão simplesmente não aparece lá.
   */
  const handleSaveWhatsApp = async () => {
    if (!selectedId) return;

    const whatsapp = whatsappValue.trim();
    // `formatWhatsAppPhoneForDisplay` devolve null para números inválidos.
    if (whatsapp && !formatWhatsAppPhoneForDisplay(whatsapp)) {
      setWhatsappError(
        "Informe um WhatsApp válido com DDD (ex.: (17) 99999-9999)."
      );
      setWhatsappSuccess(null);
      setWhatsappWarning(null);
      return;
    }

    setIsSavingWhatsApp(true);
    setWhatsappError(null);
    setWhatsappSuccess(null);
    setWhatsappWarning(null);
    try {
      const res = await fetch("/api/establishment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          // String vazia limpa o número cadastrado na loja.
          whatsapp,
          whatsapp_checkout_enabled: whatsappCheckoutEnabled,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        warning?: string;
        establishment?: Establishment;
      };
      if (!res.ok) {
        throw new Error(json.error ?? "Falha ao salvar o WhatsApp da loja.");
      }

      const warning =
        typeof json.warning === "string" && json.warning ? json.warning : null;
      setWhatsappWarning(warning);
      const saved = json.establishment;
      if (saved) {
        setEstablishmentData((prev) => ({ ...(prev ?? saved), ...saved }));
        // A API devolve o número no formato de exibição (já normalizado).
        if (saved.whatsapp !== undefined) {
          setWhatsappValue(saved.whatsapp ?? "");
        }
      }
      setWhatsappSuccess(
        warning
          ? "Número salvo. A preferência de envio será gravada após criar a coluna pendente."
          : "Telefone/WhatsApp e preferência de envio salvos."
      );
    } catch (err) {
      setWhatsappError(
        err instanceof Error ? err.message : "Erro inesperado ao salvar."
      );
    } finally {
      setIsSavingWhatsApp(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-950">
      <AdminHeader
        establishmentId={selectedId}
        isSuperAdmin={isSuperAdmin}
        badge={
          saveSuccess ? (
            <span className="rounded-full bg-green-400/15 px-3 py-1.5 text-sm font-semibold text-green-300">
              {saveSuccess}
            </span>
          ) : null
        }
      />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
          </div>
        )}

        {/* Dados públicos da loja (nome, descrição e link exibidos na vitrine) */}
        <section className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 className="font-semibold text-white">Dados da Loja</h2>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            Nome, texto e link exibidos no cardápio público. O link abaixo é
            apenas informativo — ele é gerado no cadastro e não pode ser
            alterado por aqui.
          </p>

          <div className="mt-4 flex flex-col gap-4">
            {/* Link público: somente leitura + cópia (o slug não é editável). */}
            <div>
              <span className="mb-1.5 block text-sm font-medium text-gray-300">
                Link da loja
              </span>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  readOnly
                  value={storeLink}
                  aria-label="Link público da loja (somente leitura)"
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full cursor-text rounded-xl border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm text-gray-400 outline-none focus:border-gray-700"
                />
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyStoreLink()}
                    className="rounded-xl border border-gray-700 px-3 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
                  >
                    {storeLinkCopied ? "Copiado!" : "Copiar"}
                  </button>
                  <a
                    href={storePath}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-gray-700 px-3 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
                  >
                    Abrir
                  </a>
                </div>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Endereço fixo do cardápio — não é possível editar o slug.
              </p>
            </div>

            <div>
              <label
                htmlFor="store-name"
                className="mb-1.5 block text-sm font-medium text-gray-300"
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
                className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 hover:border-gray-600 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/30"
              />
              <p className="mt-1 text-xs text-gray-500">
                {nameValue.trim().length}/80 caracteres
              </p>
            </div>

            <div>
              <label
                htmlFor="store-description"
                className="mb-1.5 block text-sm font-medium text-gray-300"
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
                className="w-full resize-y rounded-xl border border-gray-700 bg-gray-950 px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 hover:border-gray-600 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400/30"
              />
              <p className="mt-1 text-xs text-gray-500">
                Deixe vazio para exibir o badge “DELIVERY” padrão.{" "}
                {descriptionValue.trim().length}/200 caracteres
              </p>
            </div>
          </div>

          {infoError && <p className="mt-3 text-sm text-red-400">{infoError}</p>}
          {infoSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {infoSuccess}
            </p>
          )}
          {infoWarning && (
            <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
              {infoWarning}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleSaveInfo}
              disabled={isSavingInfo || !selectedId || !nameValue.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingInfo ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-950 border-t-transparent" />
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
          className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 id="opening-hours-title" className="font-semibold text-white">
              Horário de Funcionamento
            </h2>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            Ative os dias em que a loja abre e informe a abertura/fechamento.
            Fora desses horários a vitrine exibe &quot;Fechado no momento&quot; e
            os pedidos são bloqueados.
          </p>

          <div className="mt-4 divide-y divide-gray-800 overflow-hidden rounded-xl border border-gray-800">
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
                  className="flex flex-col gap-3 bg-gray-950/30 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
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
                      className="h-4 w-4 cursor-pointer rounded border-gray-600 bg-gray-900 accent-yellow-400 focus:ring-2 focus:ring-yellow-400/40"
                    />
                    <span
                      className={`text-sm font-medium ${
                        value.enabled ? "text-gray-200" : "text-gray-500"
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
                    <span className="text-xs font-medium text-gray-500">às</span>
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
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-600">
                        Fechado
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-2 text-xs text-gray-500">
            Fechamento menor que a abertura indica virada de noite (ex.: 18:00 às
            02:00). Horários iguais significam funcionamento 24h naquele dia.
          </p>

          {hoursError && <p className="mt-3 text-sm text-red-400">{hoursError}</p>}
          {hoursSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {hoursSuccess}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleSaveHours}
              disabled={isSavingHours || !selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingHours ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-950 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar horários"
              )}
            </button>
          </div>
        </section>

        {/* Entrega e frete: modelo fixo/por distância, raio e origem (CEP da loja) */}
        <section
          aria-labelledby="delivery-title"
          className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2 id="delivery-title" className="font-semibold text-white">
              Entrega e Frete
            </h2>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            Defina como a taxa de entrega é calculada. No modelo por distância, a
            taxa base vale até a distância inclusa e cada km excedente é cobrado
            pelo valor adicional. O raio máximo vale para os dois modelos e o
            checkout bloqueia endereços fora dele.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="delivery-type"
                className="mb-1.5 block text-sm font-medium text-gray-300"
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
                className="mb-1.5 block text-sm font-medium text-gray-300"
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
              <p className="mt-1 text-xs text-gray-500">
                {deliveryForm.delivery_type === "distance"
                  ? "Usada quando não for possível calcular a distância até o cliente."
                  : "Valor cobrado em todos os pedidos de entrega."}
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-gray-800 bg-gray-950/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Previsão de entrega
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Janela informada ao cliente no rastreio do pedido. O horário previsto
              é calculado a partir do tempo máximo.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="estimated-delivery-min"
                  className="mb-1.5 block text-sm font-medium text-gray-300"
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
                  className="mb-1.5 block text-sm font-medium text-gray-300"
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
            <div className="mt-4 rounded-xl border border-gray-800 bg-gray-950/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Cálculo por distância
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="distance-base-km"
                    className="mb-1.5 block text-sm font-medium text-gray-300"
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
                    className="mb-1.5 block text-sm font-medium text-gray-300"
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
                    className="mb-1.5 block text-sm font-medium text-gray-300"
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
              <p className="mt-2 text-xs text-gray-500">
                Exemplo: base de 3 km por R$ 5,00 + R$ 1,50/km excedente. Um pedido
                a 5 km custa R$ 8,00.
              </p>
            </div>
          )}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="max-delivery-radius"
                className="mb-1.5 block text-sm font-medium text-gray-300"
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
              <p className="mt-1 text-xs text-gray-500">
                Deixe vazio para não limitar. Endereços além do raio são
                bloqueados no checkout.
              </p>
            </div>

            <div>
              <label
                htmlFor="store-cep"
                className="mb-1.5 block text-sm font-medium text-gray-300"
              >
                CEP da loja (origem do cálculo)
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="store-cep"
                  type="text"
                  inputMode="numeric"
                  maxLength={9}
                  value={deliveryForm.store_cep}
                  onChange={(e) =>
                    updateDeliveryField("store_cep", e.target.value)
                  }
                  placeholder="00000-000"
                  className={deliveryInputClass}
                />
                <button
                  type="button"
                  onClick={() => void handleLookupStoreCep()}
                  disabled={isGeocodingStore || !selectedId}
                  className="shrink-0 rounded-xl border border-yellow-400/40 bg-yellow-400/10 px-4 py-2.5 text-sm font-semibold text-yellow-300 transition hover:bg-yellow-400/20 focus:outline-none focus:ring-2 focus:ring-yellow-400/40 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isGeocodingStore ? "Buscando..." : "Buscar localização"}
                </button>
              </div>
              {storeLocation ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-green-400">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" />
                  <span>
                    {storeLocation.label} · {storeLocation.latitude.toFixed(5)},{" "}
                    {storeLocation.longitude.toFixed(5)}
                  </span>
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-amber-400">
                  Informe o CEP e clique em “Buscar localização” — as coordenadas
                  são necessárias para calcular a distância até o cliente.
                </p>
              )}
            </div>
          </div>

          {deliveryError && (
            <p className="mt-3 text-sm text-red-400">{deliveryError}</p>
          )}
          {deliverySuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {deliverySuccess}
            </p>
          )}
          {deliveryWarning && (
            <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
              {deliveryWarning}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveDelivery()}
              disabled={isSavingDelivery || !selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingDelivery ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-950 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar entrega"
              )}
            </button>
          </div>
        </section>

        {/* Envio do resumo do pedido no WhatsApp (migração 20261110000016) */}
        <section
          aria-labelledby="whatsapp-checkout-title"
          className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 sm:p-6"
        >
          <div className="flex items-center gap-2">
            <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
            <h2
              id="whatsapp-checkout-title"
              className="font-semibold text-white"
            >
              Pedidos no WhatsApp
            </h2>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            O pedido continua sendo registrado no painel normalmente. Com esta
            opção ativa, o cliente vê ao finalizar o checkout um botão para
            enviar o resumo completo (itens, adicionais, endereço e valores)
            para o WhatsApp da loja.
          </p>

          {/* Telefone/WhatsApp da loja: sempre editável pelo lojista. */}
          <div className="mt-4">
            <label
              htmlFor="store-whatsapp"
              className="mb-1.5 block text-sm font-medium text-gray-300"
            >
              Telefone / WhatsApp da loja
            </label>
            <input
              id="store-whatsapp"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={whatsappValue}
              onChange={(e) => {
                setWhatsappValue(e.target.value);
                setWhatsappError(null);
                setWhatsappSuccess(null);
                setWhatsappWarning(null);
              }}
              maxLength={20}
              placeholder="(17) 99999-9999"
              aria-invalid={whatsappInvalid}
              aria-describedby="store-whatsapp-hint"
              className={contactInputClass}
            />
            <p
              id="store-whatsapp-hint"
              className={`mt-1 text-xs ${
                whatsappInvalid ? "text-red-400" : "text-gray-500"
              }`}
            >
              {whatsappInvalid
                ? "Número inválido — informe DDD + número (ex.: (17) 99999-9999)."
                : "Número com DDD que recebe o resumo do pedido. Altere e salve quando precisar."}
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-gray-800 bg-gray-950/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p
                id="whatsapp-checkout-label"
                className="text-sm font-medium text-gray-200"
              >
                Enviar resumo do pedido para o WhatsApp do estabelecimento ao
                finalizar
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {whatsappPreview
                  ? `Número usado no checkout: ${whatsappPreview}`
                  : "Nenhum WhatsApp/telefone válido cadastrado — o botão não aparecerá no checkout até que um número seja cadastrado."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={whatsappCheckoutEnabled}
              aria-labelledby="whatsapp-checkout-label"
              onClick={() => {
                setWhatsappCheckoutEnabled((prev) => !prev);
                setWhatsappSuccess(null);
                setWhatsappError(null);
                setWhatsappWarning(null);
              }}
              disabled={!selectedId || isSavingWhatsApp}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-yellow-400/40 disabled:cursor-not-allowed disabled:opacity-60 ${
                whatsappCheckoutEnabled ? "bg-yellow-400" : "bg-gray-700"
              }`}
            >
              <span className="sr-only">
                {whatsappCheckoutEnabled ? "Desativar" : "Ativar"} envio do
                resumo pelo WhatsApp
              </span>
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  whatsappCheckoutEnabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/*
           * Base sem a migração 16: o campo não vem no `select("*")`. Avisa o
           * lojista antes de ele tentar salvar (o PUT também devolve erro).
           */}
          {establishmentData &&
            establishmentData.whatsapp_checkout_enabled === undefined && (
              <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
                A coluna <code>whatsapp_checkout_enabled</code> ainda não existe
                no banco. Execute a migração{" "}
                <code>20261110000016_add_whatsapp_checkout_setting.sql</code> no
                SQL Editor do Supabase para que esta preferência seja gravada.
              </p>
            )}

          {whatsappError && (
            <p className="mt-3 text-sm text-red-400">{whatsappError}</p>
          )}
          {whatsappSuccess && (
            <p className="mt-3 flex items-center gap-2 text-sm text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
              {whatsappSuccess}
            </p>
          )}
          {whatsappWarning && (
            <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
              {whatsappWarning}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveWhatsApp()}
              disabled={isSavingWhatsApp || !selectedId || whatsappInvalid}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingWhatsApp ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-950 border-t-transparent" />
                  Salvando...
                </>
              ) : (
                "Salvar WhatsApp"
              )}
            </button>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {VISUAL_FIELDS.map((field) => {
            const isLogo = field.key === "logo_url";
            const state = isLogo ? logo : banner;
            const currentUrl = isLogo ? establishmentData?.logo_url : establishmentData?.banner_url;
            return (
              <section key={field.key} className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 sm:p-6">
                <div className="flex items-center gap-2">
                  <span className="mt-1.5 h-2.5 w-2.5 rounded-full bg-yellow-400" />
                  <h2 className="font-semibold text-white">{field.label}</h2>
                </div>
                <div className="mt-4 relative h-44 w-full overflow-hidden rounded-xl border border-gray-800 bg-gray-950">
                  {/* Prévia instantânea (arquivo novo) tem prioridade sobre a imagem salva. */}
                  {(() => {
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
                          <div className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-yellow-400 px-2.5 py-1 text-[11px] font-semibold text-gray-950 shadow-md">
                            <span className="h-1.5 w-1.5 rounded-full bg-gray-950/70" />
                            Novo · não salvo
                          </div>
                        ) : (
                          <div className="absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-gray-300 ring-1 ring-white/10">
                            <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                            Atual
                          </div>
                        )}
                        {state.status === "uploading" && (
                          <div className="absolute inset-0 flex items-center justify-center bg-gray-950/60">
                            <span className="h-6 w-6 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
                          </div>
                        )}
                      </>
                    ) : (
                      /* Estado vazio elegante: ícone discreto + texto auxiliar. */
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
                        <span className="rounded-xl border border-dashed border-gray-700 bg-gray-900/60 p-3">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                            aria-hidden="true"
                            className="h-6 w-6 text-gray-600"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
                            />
                          </svg>
                        </span>
                        <p className="text-sm font-medium text-gray-500">{field.emptyText}</p>
                        <p className="text-xs text-gray-600">{field.hint}</p>
                      </div>
                    );
                  })()}
                </div>

                <div className="mt-4">
                  <label className="mb-1.5 block text-sm font-medium text-gray-300">
                    {state.status === "stored" ? "Alterar imagem" : "Enviar nova imagem"}
                  </label>
                  <input
                    type="file"
                    accept={ACCEPT_ATTR}
                    className="w-full cursor-pointer rounded-xl border border-gray-700 bg-gray-950 px-3 py-2.5 text-sm text-gray-100 outline-none transition hover:border-gray-600 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-yellow-400/15 file:px-4 file:py-2.5 file:text-gray-950 hover:file:bg-yellow-400/20"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      // Zera o input para permitir reselecionar o mesmo arquivo.
                      e.target.value = "";
                      if (file) void handleFile(field.key, file);
                    }}
                  />
                  {state.error && <p className="mt-1.5 text-xs text-red-400">{state.error}</p>}
                  {state.status === "uploading" && (
                    <p className="mt-1.5 flex items-center gap-2 text-xs text-gray-400">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
                      Enviando...
                    </p>
                  )}
                  {state.status === "stored" && state.url && (
                    <p className="mt-1.5 flex items-center gap-2 text-xs text-green-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                      Pronto. Clique em {" "}
                      <button type="button" className="font-semibold text-yellow-300 hover:underline" onClick={() => clearPreview(field.key)}>
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

        {loadError && <p className="text-sm text-red-400">{loadError}</p>}
        {saveError && <p className="text-sm text-red-400">{saveError}</p>}

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasStored || isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? (<><span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-950 border-t-transparent" />Salvando...</>) : ("Salvar alterações")}
          </button>
        </div>
      </main>
    </div>
  );
}
