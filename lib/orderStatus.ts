import type { OrderStatus } from "@/lib/types";

/** Metadados visuais de cada status de pedido no painel. */
export interface OrderStatusMeta {
  label: string;
  /** Classes do badge (fundo/texto/anel) no tema claro do painel. */
  badgeClass: string;
  /** Cor do ponto indicador. */
  dotClass: string;
}

/**
 * Modalidade de atendimento escolhida pelo cliente no checkout:
 * - `entrega`  → receber em casa (cobra taxa de entrega e exige endereço);
 * - `retirada` → retirar no balcão da loja (sem taxa e sem endereço).
 *
 * É gravada em `orders.delivery_type` (migração 20261113000001). Pedidos
 * antigos, anteriores à coluna, são classificados pela presença de endereço
 * (mesma regra histórica do painel: sem endereço = retirada).
 */
export type OrderDeliveryType = "entrega" | "retirada";

/** Campos mínimos usados para descobrir a modalidade de um pedido. */
interface OrderDeliveryTypeFields {
  delivery_type?: string | null;
  customer_address?: {
    street?: string | null;
    number?: string | null;
    neighborhood?: string | null;
  } | null;
}

/**
 * Normaliza o valor da coluna/entrada (`entrega`/`delivery`,
 * `retirada`/`pickup`). Retorna `null` para valores desconhecidos.
 */
export function normalizeOrderDeliveryType(
  value: unknown
): OrderDeliveryType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "retirada" ||
    normalized === "pickup" ||
    normalized === "takeaway"
  ) {
    return "retirada";
  }
  if (normalized === "entrega" || normalized === "delivery") return "entrega";
  return null;
}

/**
 * Modalidade efetiva do pedido.
 *
 * Usa `orders.delivery_type` quando gravado e, para pedidos legados (sem a
 * coluna), cai na regra do painel: endereço preenchido = entrega; sem endereço
 * = retirada no balcão.
 */
export function orderDeliveryType(
  order: OrderDeliveryTypeFields | null | undefined
): OrderDeliveryType {
  const explicit = normalizeOrderDeliveryType(order?.delivery_type);
  if (explicit) return explicit;

  const address = order?.customer_address;
  const text = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";
  const hasAddress = Boolean(
    address &&
      (text(address.street) || text(address.number) || text(address.neighborhood))
  );
  return hasAddress ? "entrega" : "retirada";
}

/** `true` quando o pedido é para retirada no balcão. */
export function isPickupOrder(
  order: OrderDeliveryTypeFields | null | undefined
): boolean {
  return orderDeliveryType(order) === "retirada";
}

/** Rótulo curto da modalidade ("Entrega" | "Retirada"). */
export function orderDeliveryTypeLabel(
  deliveryType: OrderDeliveryType
): "Entrega" | "Retirada" {
  return deliveryType === "retirada" ? "Retirada" : "Entrega";
}

export const ORDER_STATUS_META: Record<OrderStatus, OrderStatusMeta> = {
  pendente: {
    label: "Pendente",
    badgeClass: "bg-amber-100 text-amber-700 ring-amber-200",
    dotClass: "bg-yellow-400",
  },
  preparando: {
    label: "Em Preparo",
    badgeClass: "bg-sky-100 text-sky-700 ring-sky-200",
    dotClass: "bg-sky-400",
  },
  entrega: {
    label: "Saiu para Entrega",
    badgeClass: "bg-orange-100 text-orange-700 ring-orange-200",
    dotClass: "bg-orange-400",
  },
  finalizado: {
    label: "Concluído",
    badgeClass: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    dotClass: "bg-emerald-500",
  },
  cancelado: {
    label: "Cancelado",
    badgeClass: "bg-red-100 text-red-700 ring-red-200",
    dotClass: "bg-red-500",
  },
};

/**
 * Fluxo operacional canônico do pedido. `cancelado` fica de fora porque é um
 * estado lateral: o operador pode cancelar de qualquer etapa e reativar o
 * pedido voltando para uma destas etapas.
 */
export const ORDER_STATUS_FLOW: OrderStatus[] = [
  "pendente",
  "preparando",
  "entrega",
  "finalizado",
];

/** Status oferecidos no seletor do painel (fluxo + cancelamento). */
export const ORDER_STATUS_OPTIONS: OrderStatus[] = [
  ...ORDER_STATUS_FLOW,
  "cancelado",
];

/** Etapa anterior no fluxo (null quando já está na primeira ou cancelado). */
export function previousOrderStatus(status: OrderStatus): OrderStatus | null {
  const index = ORDER_STATUS_FLOW.indexOf(status);
  return index > 0 ? ORDER_STATUS_FLOW[index - 1] : null;
}

/** Próxima etapa no fluxo (null quando já está na última ou cancelado). */
export function nextOrderStatus(status: OrderStatus): OrderStatus | null {
  const index = ORDER_STATUS_FLOW.indexOf(status);
  return index >= 0 && index < ORDER_STATUS_FLOW.length - 1
    ? ORDER_STATUS_FLOW[index + 1]
    : null;
}

/** Rótulo curto da ação rápida que avança o pedido para a próxima etapa. */
const NEXT_ORDER_ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  pendente: "Preparar",
  preparando: "Enviar",
  entrega: "Finalizar",
};

/**
 * Rótulo do status adaptado à modalidade do pedido.
 *
 * Na etapa `entrega` a mensagem muda de sentido para quem retira no balcão:
 * - entrega  → "Saiu para Entrega";
 * - retirada → "Pronto para buscar".
 *
 * Demais etapas usam o rótulo padrão de `ORDER_STATUS_META`.
 */
export function orderStatusLabel(
  status: OrderStatus,
  deliveryType: OrderDeliveryType = "entrega"
): string {
  if (status === "entrega" && deliveryType === "retirada") {
    return "Pronto para buscar";
  }
  return ORDER_STATUS_META[status].label;
}

/**
 * Texto da ação de avançar exibido no card (ex.: "Preparar").
 * Retorna null quando não há próxima etapa (finalizado/cancelado).
 *
 * Em pedidos de retirada, `preparando → entrega` significa "ficou pronto no
 * balcão", então a ação é rotulada como "Marcar pronto".
 */
export function nextOrderActionLabel(
  status: OrderStatus,
  deliveryType: OrderDeliveryType = "entrega"
): string | null {
  if (!nextOrderStatus(status)) return null;
  if (status === "preparando" && deliveryType === "retirada") {
    return "Marcar pronto";
  }
  return NEXT_ORDER_ACTION_LABEL[status] ?? null;
}

/**
 * true = o pedido pode ser cancelado pelo atendente.
 * O cancelamento é permitido em qualquer etapa (inclusive após finalizado);
 * apenas um pedido já cancelado não pode ser cancelado novamente.
 */
export function canCancelOrder(status: OrderStatus): boolean {
  return status !== "cancelado";
}
