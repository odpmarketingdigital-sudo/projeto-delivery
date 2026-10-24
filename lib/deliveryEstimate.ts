/**
 * Previsão de entrega compartilhada entre API, painel e rastreio do cliente.
 *
 * A loja configura uma janela (mínimo/máximo em minutos). O pedido grava o
 * texto normalizado (`estimated_delivery_time`) e o instante previsto
 * (`estimated_delivery_at`) no momento da criação/atualização.
 */

export interface EstimatedDeliveryWindow {
  /** Tempo mínimo estimado, em minutos. */
  min: number;
  /** Tempo máximo estimado, em minutos. */
  max: number;
}

/** Padrão usado quando a loja ainda não configurou a previsão. */
export const DEFAULT_ESTIMATED_DELIVERY_TIME_MIN = 30;
export const DEFAULT_ESTIMATED_DELIVERY_TIME_MAX = 50;

/** Limites aceitos na configuração (minutos). */
export const MIN_ESTIMATED_DELIVERY_MINUTES = 1;
export const MAX_ESTIMATED_DELIVERY_MINUTES = 600;

/** Opções rápidas exibidas no painel ao atualizar o status. */
export const ESTIMATED_DELIVERY_OPTIONS: ReadonlyArray<EstimatedDeliveryWindow> =
  [
    { min: 20, max: 30 },
    { min: 30, max: 45 },
    { min: 45, max: 60 },
    { min: 60, max: 90 },
  ];

/** Valida uma janela de previsão (inteiros dentro dos limites e max >= min). */
export function isValidEstimatedDeliveryWindow(
  window: EstimatedDeliveryWindow
): boolean {
  return (
    Number.isInteger(window.min) &&
    Number.isInteger(window.max) &&
    window.min >= MIN_ESTIMATED_DELIVERY_MINUTES &&
    window.max <= MAX_ESTIMATED_DELIVERY_MINUTES &&
    window.max >= window.min
  );
}

/** Converte um valor cru (número ou string numérica) em minutos inteiros. */
function toEstimativeMinutes(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    parsed = Number(value);
  } else {
    return null;
  }
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Normaliza a janela configurada no estabelecimento.
 *
 * Aceita números ou strings numéricas (a API pode serializar `numeric` como
 * string) e cai nos padrões quando as colunas ainda não existem na base —
 * mesmo comportamento tolerante usado pelas demais configurações de entrega.
 */
export function normalizeEstimatedDeliveryWindow(
  source:
    | {
        estimated_delivery_time_min?: unknown;
        estimated_delivery_time_max?: unknown;
      }
    | null
    | undefined,
  fallback: EstimatedDeliveryWindow = {
    min: DEFAULT_ESTIMATED_DELIVERY_TIME_MIN,
    max: DEFAULT_ESTIMATED_DELIVERY_TIME_MAX,
  }
): EstimatedDeliveryWindow {
  const parsedMin = toEstimativeMinutes(source?.estimated_delivery_time_min);
  const parsedMax = toEstimativeMinutes(source?.estimated_delivery_time_max);

  // Mantém um valor válido parcial (ex.: só o mínimo configurado) em vez de
  // descartar a configuração inteira.
  const min =
    parsedMin != null &&
    parsedMin >= MIN_ESTIMATED_DELIVERY_MINUTES &&
    parsedMin <= MAX_ESTIMATED_DELIVERY_MINUTES
      ? parsedMin
      : fallback.min;
  const max =
    parsedMax != null &&
    parsedMax >= min &&
    parsedMax <= MAX_ESTIMATED_DELIVERY_MINUTES
      ? parsedMax
      : Math.max(min, fallback.max);

  const window = { min, max };
  return isValidEstimatedDeliveryWindow(window) ? window : { ...fallback };
}

/**
 * Lê um texto como "30-45 min", "30 a 45 min" ou "30 min" e devolve a janela
 * correspondente. Retorna `null` quando o formato não é reconhecido ou os
 * valores são inválidos.
 */
export function parseEstimatedDeliveryWindow(
  value: unknown
): EstimatedDeliveryWindow | null {
  if (typeof value !== "string") return null;
  const match = value.match(
    /(\d{1,3})(?:\s*(?:-|a|–)\s*(\d{1,3}))?/i
  );
  if (!match) return null;
  const window = {
    min: Number(match[1]),
    max: match[2] ? Number(match[2]) : Number(match[1]),
  };
  return isValidEstimatedDeliveryWindow(window) ? window : null;
}

/** Texto canônico persistido em `orders.estimated_delivery_time`. */
export function formatEstimatedDeliveryWindow(
  window: EstimatedDeliveryWindow
): string {
  return window.min === window.max
    ? `${window.min} min`
    : `${window.min}-${window.max} min`;
}

/** Rótulo amigável para a interface ("30 a 45 min"). */
export function formatEstimatedDeliveryWindowLabel(
  window: EstimatedDeliveryWindow
): string {
  return window.min === window.max
    ? `${window.min} min`
    : `${window.min} a ${window.max} min`;
}

/** Instante previsto de entrega a partir de agora + tempo máximo. */
export function estimatedDeliveryAtFromNow(
  window: EstimatedDeliveryWindow,
  now: Date = new Date()
): string {
  return new Date(now.getTime() + window.max * 60_000).toISOString();
}
