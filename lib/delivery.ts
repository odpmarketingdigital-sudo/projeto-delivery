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
  /** CEP da loja (somente dígitos). */
  store_cep: string | null;
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

export interface DeliveryQuote {
  delivery_type: DeliveryType;
  fee: number;
  distance_km: number | null;
  within_radius: boolean;
  max_delivery_radius_km: number | null;
  fee_source: DeliveryFeeSource;
  /** O checkout precisa de um CEP válido para concluir o pedido. */
  requires_cep: boolean;
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

/** Formata progressivamente um CEP para o input (`12345-678`). */
export function formatCep(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
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
 */
export function buildDeliveryQuote(
  settings: DeliverySettings,
  distanceKm: number | null
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

  return {
    delivery_type: settings.delivery_type,
    fee: hasDistance
      ? computeDistanceFee(settings, usableDistanceKm)
      : roundMoney(settings.delivery_fee),
    distance_km: usableDistanceKm,
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
