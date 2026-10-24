"use client";

import type { OrderStatus, PanelOrder } from "@/lib/types";
import { ORDER_STATUS_META } from "@/lib/orderStatus";
import { OrderCard } from "./OrderCard";

interface KanbanColumnProps {
  title: string;
  status: OrderStatus;
  orders: PanelOrder[];
  shortNumbers: Map<string, string>;
  /** Abre o modal de detalhes do pedido selecionado. */
  onOpenOrder: (order: PanelOrder) => void;
  /** Avança o pedido para a próxima etapa (ação rápida do card). */
  onAdvanceOrder: (order: PanelOrder, nextStatus: OrderStatus) => void;
  /** Pedidos com atualização de status em andamento. */
  busyIds: Set<string>;
  highlight?: boolean;
}

export function KanbanColumn({
  title,
  status,
  orders,
  shortNumbers,
  onOpenOrder,
  onAdvanceOrder,
  busyIds,
  highlight,
}: KanbanColumnProps) {
  const meta = ORDER_STATUS_META[status];

  return (
    <section
      className={`flex flex-1 flex-col overflow-hidden rounded-xl border shadow-sm ${
        highlight
          ? "border-yellow-400/60 bg-yellow-400/5"
          : "border-gray-700/60 bg-gray-800/30"
      }`}
    >
      <h2 className="flex items-center gap-2 border-b border-gray-700/60 px-4 py-3 text-xs font-bold uppercase tracking-widest text-gray-400">
        <span className={`inline-flex h-2.5 w-2.5 rounded-full ${meta.dotClass}`} />
        {title}
        <span className="ml-auto rounded-full bg-gray-700/70 px-2 py-0.5 text-[10px] tabular-nums text-gray-300">
          {orders.length}
        </span>
      </h2>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {orders.length === 0 ? (
          <p className="rounded-lg bg-gray-700/30 px-3 py-2 text-center text-xs font-medium text-gray-500">
            Nenhum pedido
          </p>
        ) : (
          orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              shortNumber={shortNumbers.get(order.id) ?? `#${order.id.slice(0, 8)}`}
              onOpen={onOpenOrder}
              onAdvance={onAdvanceOrder}
              isBusy={busyIds.has(order.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}
