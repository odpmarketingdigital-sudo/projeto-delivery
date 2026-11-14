"use client";

import type { PanelOrder } from "@/lib/types";
import {
  ORDER_STATUS_META,
  orderDeliveryType,
  orderStatusLabel,
} from "@/lib/orderStatus";
import { STORE_TIME_ZONE } from "@/lib/openingHours";

interface OrdersTableProps {
  orders: PanelOrder[];
  /** Número curto exibido (#0001…) — derivado da posição/created_at. */
  shortNumbers: Map<string, string>;
  /** Abre o modal com os detalhes completos do pedido. */
  onOpenOrder: (order: PanelOrder) => void;
  /** Pedidos com atualização de status em andamento. */
  busyIds?: Set<string>;
  /**
   * Botão **Aceitar pedido** para as linhas pendentes: confirma o pedido e
   * dispara a mensagem de confirmação no WhatsApp do cliente.
   */
  onAcceptOrder?: (order: PanelOrder) => void;
}

function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

/** Horário do pedido no fuso da loja (o banco grava `created_at` em UTC). */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: STORE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function itemsLabel(order: PanelOrder): string {
  const count = order.items.reduce((sum, item) => sum + item.quantity, 0);
  if (count === 0) return "—";
  return `${count} item${count > 1 ? "s" : ""}`;
}

/**
 * Visão em lista (tabela) dos pedidos do painel.
 *
 * Recebe a MESMA coleção filtrada por data usada pelo Kanban, garantindo que a
 * troca de dia no seletor atualize as duas visualizações de forma consistente.
 */
export function OrdersTable({
  orders,
  shortNumbers,
  onOpenOrder,
  busyIds,
  onAcceptOrder,
}: OrdersTableProps) {
  if (orders.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
        Nenhum pedido nesta data.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-300">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-slate-100 text-[11px] uppercase tracking-wider text-slate-600">
          <tr>
            <th scope="col" className="px-4 py-3 font-bold">
              Pedido
            </th>
            <th scope="col" className="px-4 py-3 font-bold">
              Cliente
            </th>
            <th scope="col" className="px-4 py-3 font-bold">
              Itens
            </th>
            <th scope="col" className="px-4 py-3 text-right font-bold">
              Total
            </th>
            <th scope="col" className="px-4 py-3 font-bold">
              Status
            </th>
            <th scope="col" className="px-4 py-3 font-bold">
              Previsão
            </th>
            <th scope="col" className="px-4 py-3 font-bold">
              Horário
            </th>
            <th scope="col" className="px-4 py-3 text-right font-bold">
              Ações
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {orders.map((order) => {
            const meta = ORDER_STATUS_META[order.status];
            // Pedidos de retirada exibem "Pronto para buscar" na etapa final.
            const statusLabel = orderStatusLabel(
              order.status,
              orderDeliveryType(order)
            );
            const shortNumber =
              shortNumbers.get(order.id) ?? `#${order.id.slice(0, 8)}`;

            return (
              <tr
                key={order.id}
                className={
                  order.status === "pendente"
                    ? "bg-yellow-400/5"
                    : "hover:bg-slate-100"
                }
              >
                <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-900">
                  {shortNumber}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-800">
                    {order.customer_name}
                  </p>
                  {order.customer_phone && (
                    <p className="text-xs tabular-nums text-slate-500">
                      {order.customer_phone}
                    </p>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                  {itemsLabel(order)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums text-amber-600">
                  {formatBRL(order.total)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${meta.badgeClass}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
                    {statusLabel}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                  {order.estimated_delivery_time ?? "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">
                  {formatTime(order.created_at)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    {order.status === "pendente" && onAcceptOrder && (
                      <button
                        type="button"
                        onClick={() => onAcceptOrder(order)}
                        disabled={busyIds?.has(order.id)}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400/50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busyIds?.has(order.id) ? "Aceitando…" : "Aceitar"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenOrder(order)}
                      aria-label={`Abrir detalhes do pedido ${shortNumber}`}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 transition hover:border-amber-300 hover:text-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                    >
                      Detalhes
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
