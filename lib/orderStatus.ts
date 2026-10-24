import type { OrderStatus } from "@/lib/types";

/** Metadados visuais de cada status de pedido no painel. */
export interface OrderStatusMeta {
  label: string;
  /** Classes do badge (fundo/texto/anel) no tema escuro do painel. */
  badgeClass: string;
  /** Cor do ponto indicador. */
  dotClass: string;
}

export const ORDER_STATUS_META: Record<OrderStatus, OrderStatusMeta> = {
  pendente: {
    label: "Pendente",
    badgeClass: "bg-yellow-400/15 text-yellow-300 ring-yellow-400/30",
    dotClass: "bg-yellow-400",
  },
  preparando: {
    label: "Em Preparo",
    badgeClass: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
    dotClass: "bg-sky-400",
  },
  entrega: {
    label: "Saiu para Entrega",
    badgeClass: "bg-orange-400/15 text-orange-300 ring-orange-400/30",
    dotClass: "bg-orange-400",
  },
  finalizado: {
    label: "Concluído",
    badgeClass: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30",
    dotClass: "bg-emerald-500",
  },
  cancelado: {
    label: "Cancelado",
    badgeClass: "bg-red-500/15 text-red-300 ring-red-500/30",
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
 * Texto da ação de avançar exibido no card (ex.: "Preparar").
 * Retorna null quando não há próxima etapa (finalizado/cancelado).
 */
export function nextOrderActionLabel(status: OrderStatus): string | null {
  return nextOrderStatus(status) ? (NEXT_ORDER_ACTION_LABEL[status] ?? null) : null;
}

/**
 * true = o pedido pode ser cancelado pelo atendente.
 * O cancelamento é permitido em qualquer etapa (inclusive após finalizado);
 * apenas um pedido já cancelado não pode ser cancelado novamente.
 */
export function canCancelOrder(status: OrderStatus): boolean {
  return status !== "cancelado";
}
