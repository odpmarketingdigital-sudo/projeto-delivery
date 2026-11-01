"use client";

import { useRef, useState, type DragEvent } from "react";
import type { OrderStatus, PanelOrder } from "@/lib/types";
import { ORDER_STATUS_META } from "@/lib/orderStatus";
import { OrderCard } from "./OrderCard";

/** Tipo MIME usado no `dataTransfer` para identificar o pedido arrastado. */
export const ORDER_DRAG_MIME = "text/plain";

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
  /**
   * Move o pedido solto nesta coluna para `status`. A coluna não decide nada:
   * o painel valida a transição e chama `PUT /api/orders`.
   */
  onDropOrder: (orderId: string, targetStatus: OrderStatus) => void;
  /** Card iniciou o arraste (o painel guarda o id para estilizar os demais). */
  onDragStartOrder: (order: PanelOrder) => void;
  /** Arraste terminou (drop aplicado ou cancelado). */
  onDragEndOrder: () => void;
  /** id do pedido em arraste — `null` quando não há arraste em andamento. */
  draggingId?: string | null;
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
  onDropOrder,
  onDragStartOrder,
  onDragEndOrder,
  draggingId = null,
  highlight,
}: KanbanColumnProps) {
  const meta = ORDER_STATUS_META[status];
  // dragenter/dragleave disparam também ao passar pelos filhos; o contador
  // evita o "pisca-pisca" do destaque enquanto o ponteiro percorre o card.
  const dragDepth = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);

  /** Só reage a arraste de cards do próprio Kanban (ignora arquivos/texto). */
  const isOrderDrag = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.types.includes(ORDER_DRAG_MIME);

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!isOrderDrag(event)) return;
    dragDepth.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isOrderDrag(event)) return;
    // preventDefault é obrigatório para o navegador permitir o drop.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!isOrderDrag(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!isOrderDrag(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    // O card pode ser movido para outra coluna no mesmo instante; limpar o
    // estado de arraste aqui evita depender do `dragend` do nó removido.
    onDragEndOrder();
    const orderId = event.dataTransfer.getData(ORDER_DRAG_MIME);
    if (!orderId) return;
    onDropOrder(orderId, status);
  };

  return (
    <section
      aria-label={`Pedidos ${title}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex flex-1 flex-col overflow-hidden rounded-xl border shadow-sm transition-colors ${
        isDragOver
          ? "border-amber-400 bg-amber-50 ring-2 ring-amber-400/50"
          : highlight
            ? "border-amber-300 bg-amber-50"
            : "border-slate-200 bg-slate-100"
      }`}
    >
      <h2 className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-xs font-bold uppercase tracking-widest text-slate-600">
        <span className={`inline-flex h-2.5 w-2.5 rounded-full ${meta.dotClass}`} />
        {title}
        <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[10px] tabular-nums text-slate-600 ring-1 ring-slate-200">
          {orders.length}
        </span>
      </h2>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {orders.length === 0 ? (
          <p
            className={`rounded-lg px-3 py-2 text-center text-xs font-medium ${
              isDragOver
                ? "bg-white text-amber-700 ring-1 ring-amber-300"
                : "bg-slate-200 text-slate-500"
            }`}
          >
            {isDragOver ? "Solte aqui" : "Nenhum pedido"}
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
              onDragStart={onDragStartOrder}
              onDragEnd={onDragEndOrder}
              isDragging={draggingId === order.id}
            />
          ))
        )}

        {orders.length > 0 && isDragOver && (
          <p className="rounded-lg border border-dashed border-amber-400 bg-white/70 px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wide text-amber-700">
            Solte para mover para {title}
          </p>
        )}
      </div>
    </section>
  );
}
