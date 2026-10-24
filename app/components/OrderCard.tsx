"use client";

import type { OrderStatus, PanelOrder } from "@/lib/types";
import {
  ORDER_STATUS_META,
  nextOrderActionLabel,
  nextOrderStatus,
} from "@/lib/orderStatus";
import {
  formatEstimatedDeliveryWindowLabel,
  parseEstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";

interface OrderCardProps {
  order: PanelOrder;
  /** Número curto exibido (#0001…) — derivado da posição/created_at. */
  shortNumber: string;
  /** Abre o modal com os detalhes completos do pedido. */
  onOpen: (order: PanelOrder) => void;
  /** Avança o pedido para a próxima etapa direto pela API (sem abrir o modal). */
  onAdvance: (order: PanelOrder, nextStatus: OrderStatus) => void;
  /** true = há uma atualização de status em andamento para este pedido. */
  isBusy?: boolean;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} às ${time}`;
}

/**
 * Card compacto da listagem: número, data/hora, status e as ações rápidas
 * "Veja mais" e "Próxima etapa". Itens, endereço, valores e as demais ações
 * ficam no OrderDetailsModal.
 */
export function OrderCard({
  order,
  shortNumber,
  onOpen,
  onAdvance,
  isBusy = false,
}: OrderCardProps) {
  const meta = ORDER_STATUS_META[order.status];
  const isPending = order.status === "pendente";
  const isCancelled = order.status === "cancelado";
  const nextStatus = nextOrderStatus(order.status);
  const nextActionLabel = nextOrderActionLabel(order.status);
  const estimateWindow = parseEstimatedDeliveryWindow(
    order.estimated_delivery_time
  );
  const estimateLabel = estimateWindow
    ? formatEstimatedDeliveryWindowLabel(estimateWindow)
    : order.estimated_delivery_time;

  return (
    <article
      className={`flex flex-col rounded-xl border p-3.5 transition ${
        isPending
          ? "border-yellow-400/70 bg-yellow-400/5"
          : isCancelled
            ? "border-red-900/60 bg-gray-800/30 opacity-80"
            : "border-gray-700/70 bg-gray-800/40"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p
            className={`whitespace-nowrap text-base font-black tracking-tight ${
              isPending ? "text-yellow-300" : "text-white"
            }`}
          >
            {shortNumber}
          </p>
          <p className="mt-0.5 whitespace-nowrap text-[11px] font-medium text-gray-400">
            {formatDateTime(order.created_at)}
          </p>
          {estimateLabel && !isCancelled && order.status !== "finalizado" && (
            <p className="mt-1 text-[11px] font-bold text-yellow-300">
              ⏱ Previsão: {estimateLabel}
            </p>
          )}
        </div>

        <span
          className={`inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${meta.badgeClass}`}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dotClass}`} />
          {meta.label}
        </span>
      </div>

      <button
        type="button"
        onClick={() => onOpen(order)}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-xs font-bold text-gray-200 transition hover:border-yellow-400/50 hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
      >
        Veja mais
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
            d="M8.25 4.5 15.75 12l-7.5 7.5"
          />
        </svg>
      </button>

      {nextStatus && nextActionLabel && (
        <button
          type="button"
          disabled={isBusy}
          aria-busy={isBusy}
          onClick={() => onAdvance(order, nextStatus)}
          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-yellow-400 px-3 py-2 text-xs font-black text-gray-950 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isBusy ? "Atualizando…" : `Próxima etapa: ${nextActionLabel}`}
          {!isBusy && (
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 4.5 21 12l-7.5 7.5M21 12H3"
              />
            </svg>
          )}
        </button>
      )}
    </article>
  );
}
