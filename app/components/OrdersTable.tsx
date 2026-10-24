"use client";

import type { PanelOrder } from "@/lib/types";
import { ORDER_STATUS_META } from "@/lib/orderStatus";
import { STORE_TIME_ZONE } from "@/lib/openingHours";

interface OrdersTableProps {
  orders: PanelOrder[];
  /** Número curto exibido (#0001…) — derivado da posição/created_at. */
  shortNumbers: Map<string, string>;
  /** Abre o modal com os detalhes completos do pedido. */
  onOpenOrder: (order: PanelOrder) => void;
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
}: OrdersTableProps) {
  if (orders.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-gray-700 px-4 py-10 text-center text-sm text-gray-500">
        Nenhum pedido nesta data.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-700/60">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-gray-800/70 text-[11px] uppercase tracking-wider text-gray-400">
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
        <tbody className="divide-y divide-gray-800">
          {orders.map((order) => {
            const meta = ORDER_STATUS_META[order.status];
            const shortNumber =
              shortNumbers.get(order.id) ?? `#${order.id.slice(0, 8)}`;

            return (
              <tr
                key={order.id}
                className={
                  order.status === "pendente"
                    ? "bg-yellow-400/5"
                    : "hover:bg-gray-800/40"
                }
              >
                <td className="whitespace-nowrap px-4 py-3 font-bold text-white">
                  {shortNumber}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-200">
                    {order.customer_name}
                  </p>
                  {order.customer_phone && (
                    <p className="text-xs tabular-nums text-gray-500">
                      {order.customer_phone}
                    </p>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-gray-300">
                  {itemsLabel(order)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums text-yellow-300">
                  {formatBRL(order.total)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${meta.badgeClass}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
                    {meta.label}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-gray-300">
                  {order.estimated_delivery_time ?? "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-gray-400">
                  {formatTime(order.created_at)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onOpenOrder(order)}
                    aria-label={`Abrir detalhes do pedido ${shortNumber}`}
                    className="rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-1.5 text-xs font-bold text-gray-200 transition hover:border-yellow-400/50 hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
                  >
                    Detalhes
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
