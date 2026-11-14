import { normalizeEstimatedDeliveryWindow } from "./deliveryEstimate";

/**
 * Regras de entrega/frete compartilhadas entre servidor e cliente.
 *
 * Este módulo é intencionalmente puro (sem imports de Node/Supabase) para que
 * possa ser usado tanto nas rotas de API quanto no checkout e no painel.
 *
 * Modelo suportado:
 *  - `fixed`: cobra sempre `delivery_fee` (comportamento legado);
 *  - `distance`: cobra `distance_base_fee` até `distance_base_km` e
 *    `distance_extra_km_fee` por km excedente.
 *
 * `max_delivery_radius_km` é opcional e vale para os dois modelos: quando
 * configurado, o endereço do cliente precisa estar dentro do raio.
 */

export type DeliveryType = "fixed" | "distance";

/** Origem da taxa aplicada em uma cotação. */
export type DeliveryFeeSource = "fixed" | "distance" | "fixed_fallback";

export interface DeliverySettings {
  delivery_type: DeliveryType;
  /** Taxa fixa (modelo `fixed` e fallback do modelo `distance`). */
  delivery_fee: number;
  /** Distância inclusa na taxa base do modelo por distância (km). */
  distance_base_km: number;
  /** Valor cobrado até `distance_base_km`. */
  distance_base_fee: number;
  /** Valor por km excedente. */
  distance_extra_km_fee: number;
  /** Raio máximo de entrega (km). `null` = sem limite. */
  max_delivery_radius_km: number | null;
  /** CEP da loja (somente dígitos) — mantido para o cadastro/pagamento. */
  store_cep: string | null;
  /** Endereço da loja por extenso (origem do cálculo do frete). */
  store_address: string | null;
  store_latitude: number | null;
  store_longitude: number | null;
  /** Tempo mínimo estimado de entrega, em minutos. */
  estimated_delivery_time_min: number;
  /** Tempo máximo estimado de entrega, em minutos. */
  estimated_delivery_time_max: number;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Origem da distância usada na cotação.
 *  - `google_routes`: rota real de carro (Google Routes API — `computeRoutes`);
 *  - `haversine`: linha reta entre os pontos (fallback sem chave/erro da API).
 */
export type DeliveryDistanceSource = "google_routes" | "haversine";

export interface DeliveryQuote {
  delivery_type: DeliveryType;
  fee: number;
  distance_km: number | null;
  /** Tempo estimado de percurso em minutos (Routes API). `null` sem rota. */
  duration_minutes: number | null;
  /** Como a distância foi obtida (`null` quando não houve cálculo). */
  distance_source: DeliveryDistanceSource | null;
  within_radius: boolean;
  max_delivery_radius_km: number | null;
  fee_source: DeliveryFeeSource;
  /** O checkout precisa do endereço (CEP ou coordenadas) para concluir. */
  requires_cep: boolean;
}

/** Dados opcionais de distância/tempo anexados à cotação. */
export interface DeliveryQuoteRoute {
  durationMinutes?: number | null;
  distanceSource?: DeliveryDistanceSource | null;
}

export const DEFAULT_DISTANCE_BASE_KM = 3;

/** Converte valores vindos do banco/formulário (number | string | null). */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonNegative(value: unknown, fallback: number): number {
  const parsed = toFiniteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : fallback;
}

/** Normaliza `delivery_type` (qualquer valor desconhecido vira `fixed`). */
export function normalizeDeliveryType(value: unknown): DeliveryType {
  return value === "distance" ? "distance" : "fixed";
}

/** Extrai somente os 8 dígitos de um CEP; retorna `null` quando inválido. */
export function parseCep(value: unknown): string | null {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits.length === 8 ? digits : null;
}

/**
 * Normaliza coordenadas vindas da borda (Places Autocomplete, JSON, query).
 *
 * Aceita `number` ou string numérica (com vírgula ou ponto) e devolve `null`
 * quando o par é inválido. `(0, 0)` é tratado como ausência de coordenada —
 * é o valor devolvido por APIs de geocodificação quando não há posição real e
 * geraria distância falsa.
 */
export function parseGeoPoint(
  latitude: unknown,
  longitude: unknown
): GeoPoint | null {
  const lat = toFiniteNumber(latitude);
  const lng = toFiniteNumber(longitude);
  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { latitude: lat, longitude: lng };
}

/** Formata progressivamente um CEP para o input (`12345-678`). */
export function formatCep(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

/**
 * Limites do endereço da loja (origem do frete) — usados no painel, na API de
 * establishment e no geocode para manter o mesmo critério em todos os pontos.
 */
export const STORE_ADDRESS_MIN_LENGTH = 8;
export const STORE_ADDRESS_MAX_LENGTH = 200;

/**
 * Normaliza o endereço da loja digitado pelo lojista.
 *
 * Apara as pontas e colapsa espaços repetidos (o texto é livre: "Av. Bady
 * Bassitt,  1500 - Centro" vira "Av. Bady Bassitt, 1500 - Centro"). Texto
 * vazio vira `null` para limpar a coluna.
 */
export function normalizeStoreAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.replace(/\s+/g, " ").trim();
  return address === "" ? null : address.slice(0, STORE_ADDRESS_MAX_LENGTH);
}

export function isValidCep(value: unknown): boolean {
  return parseCep(value) != null;
}

export function roundKm(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Arredonda a distância calculada para 2 casas decimais.
 *
 * O valor bruto continua sendo um float (ex.: `3.42`), e a interface decide
 * como exibir (normalmente 1 casa: `3,4 km`).
 */
export function roundDistanceKm(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Formata um tempo de percurso em minutos para exibição (`12 min`, `1 h 05`).
 * Retorna `null` quando o valor é inválido — a UI simplesmente omite o trecho.
 */
export function formatTravelDuration(minutes: number | null): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0
    ? `${hours} h`
    : `${hours} h ${String(rest).padStart(2, "0")}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Normaliza uma linha de `establishments` — tolerante a colunas ausentes
 * (bases legadas) e a valores numéricos retornados como string pelo Postgres.
 */
export function normalizeDeliverySettings(row: unknown): DeliverySettings {
  const source =
    row && typeof row === "object" ? (row as Record<string, unknown>) : {};

  const latitude = toFiniteNumber(source.store_latitude);
  const longitude = toFiniteNumber(source.store_longitude);
  const radius = toFiniteNumber(source.max_delivery_radius_km);
  const estimate = normalizeEstimatedDeliveryWindow(source);

  return {
    delivery_type: normalizeDeliveryType(source.delivery_type),
    delivery_fee: nonNegative(source.delivery_fee, 0),
    distance_base_km: nonNegative(
      source.distance_base_km,
      DEFAULT_DISTANCE_BASE_KM
    ),
    distance_base_fee: nonNegative(source.distance_base_fee, 0),
    distance_extra_km_fee: nonNegative(source.distance_extra_km_fee, 0),
    max_delivery_radius_km:
      radius != null && radius > 0 ? roundKm(radius) : null,
    store_cep: parseCep(source.store_cep),
    store_address: normalizeStoreAddress(source.store_address),
    store_latitude:
      latitude != null && latitude >= -90 && latitude <= 90
        ? latitude
        : null,
    store_longitude:
      longitude != null && longitude >= -180 && longitude <= 180
        ? longitude
        : null,
    estimated_delivery_time_min: estimate.min,
    estimated_delivery_time_max: estimate.max,
  };
}

/** Distância em km entre dois pontos (fórmula de Haversine). */
export function haversineDistanceKm(from: GeoPoint, to: GeoPoint): number {
  const earthRadiusKm = 6371;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Taxa do modelo por distância (base + km excedente). */
export function computeDistanceFee(
  settings: DeliverySettings,
  distanceKm: number
): number {
  const extraKm = Math.max(0, distanceKm - settings.distance_base_km);
  return roundMoney(
    settings.distance_base_fee + extraKm * settings.distance_extra_km_fee
  );
}

/** Indica se a distância informada está dentro do raio configurado. */
export function isWithinDeliveryRadius(
  settings: DeliverySettings,
  distanceKm: number | null
): boolean {
  if (distanceKm == null || settings.max_delivery_radius_km == null) {
    return true;
  }
  // Pequena tolerância para arredondamento de coordenadas/CEP.
  return distanceKm <= settings.max_delivery_radius_km + 1e-9;
}

/**
 * Monta a cotação final. Quando o modelo é `distance` mas não há distância
 * calculável, aplica `delivery_fee` como fallback seguro (nunca cobra 0 sem
 * aviso) e sinaliza `fee_source = "fixed_fallback"`.
 *
 * `route` carrega metadados opcionais da rota (tempo do Google Routes e a
 * origem da distância). Sem ele, a distância é tratada como linha reta.
 */
export function buildDeliveryQuote(
  settings: DeliverySettings,
  distanceKm: number | null,
  route?: DeliveryQuoteRoute
): DeliveryQuote {
  const isDistance = settings.delivery_type === "distance";
  // `0` costuma indicar coordenadas iguais/indisponíveis (ex.: geocodificação
  // que devolveu o centroide da cidade para origem e destino). Nesse caso a
  // distância não é útil e precisa virar `null`, nunca `0`, para que a UI não
  // exiba "0,0 km" e para acionar o fallback da taxa fixa. Também descartamos
  // distâncias que arredondariam para `0,0 km` na exibição.
  const roundedDistanceKm =
    distanceKm != null && Number.isFinite(distanceKm)
      ? roundDistanceKm(distanceKm)
      : null;
  const usableDistanceKm =
    roundedDistanceKm != null && roundKm(roundedDistanceKm) > 0
      ? roundedDistanceKm
      : null;
  const hasDistance = isDistance && usableDistanceKm != null;
  const feeSource: DeliveryFeeSource = isDistance
    ? hasDistance
      ? "distance"
      : "fixed_fallback"
    : "fixed";
  const durationMinutes =
    route?.durationMinutes != null &&
    Number.isFinite(route.durationMinutes) &&
    route.durationMinutes > 0
      ? Math.round(route.durationMinutes)
      : null;
  const distanceSource: DeliveryDistanceSource | null =
    usableDistanceKm == null
      ? null
      : (route?.distanceSource ?? "haversine");

  return {
    delivery_type: settings.delivery_type,
    fee: hasDistance
      ? computeDistanceFee(settings, usableDistanceKm)
      : roundMoney(settings.delivery_fee),
    distance_km: usableDistanceKm,
    duration_minutes: usableDistanceKm == null ? null : durationMinutes,
    distance_source: distanceSource,
    within_radius: isWithinDeliveryRadius(settings, usableDistanceKm),
    max_delivery_radius_km: settings.max_delivery_radius_km,
    fee_source: feeSource,
    requires_cep:
      settings.delivery_type === "distance" ||
      settings.max_delivery_radius_km != null,
  };
}

export function deliveryTypeLabel(type: DeliveryType): string {
  return type === "distance" ? "Por distância (km)" : "Taxa fixa";
}
