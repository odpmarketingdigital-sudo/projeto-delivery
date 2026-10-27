"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { KanbanColumn } from "@/app/components/KanbanColumn";
import { OrderDetailsModal } from "@/app/components/OrderDetailsModal";
import { OrdersTable } from "@/app/components/OrdersTable";
import { useEstablishment } from "@/app/painel/produtos/useEstablishment";
import type { OrderStatus, PanelOrder } from "@/lib/types";
import { normalizeOrderStatus } from "@/lib/types";
import { ORDER_STATUS_META } from "@/lib/orderStatus";
import {
  estimatedDeliveryAtFromNow,
  formatEstimatedDeliveryWindow,
  formatEstimatedDeliveryWindowLabel,
  type EstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";
import { formatDateBR, todayDateValue } from "@/lib/dateRange";
import { AdminHeader } from "./components/AdminHeader";
import { OrderSoundControl } from "./components/OrderSoundControl";
import { useOrderSoundContext } from "./components/OrderSoundProvider";

const COLUMNS: { status: OrderStatus; title: string; highlight?: boolean }[] = [
  { status: "pendente", title: "Pendentes", highlight: true },
  { status: "preparando", title: "Em Preparo" },
  { status: "entrega", title: "Saiu para Entrega" },
  { status: "finalizado", title: "Concluídos / Entregues" },
  { status: "cancelado", title: "Cancelados" },
];

/** Normaliza linha crua do GET /api/orders para PanelOrder (tolerante). */
function toPanelOrder(raw: unknown): PanelOrder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const status = normalizeOrderStatus(r.status);
  if (typeof r.id !== "string" || !status) return null;
  const num = (v: unknown, fb = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    id: r.id,
    establishment_id: typeof r.establishment_id === "string" ? r.establishment_id : "",
    customer_name: typeof r.customer_name === "string" ? r.customer_name : "Cliente",
    customer_phone: typeof r.customer_phone === "string" ? r.customer_phone : null,
    customer_address:
      typeof r.customer_address === "object" && r.customer_address !== null
        ? (r.customer_address as PanelOrder["customer_address"])
        : null,
    items: items.map((it) => {
      const o = (typeof it === "object" && it !== null ? it : {}) as Record<string, unknown>;
      const qty = Math.max(1, Math.floor(num(o.quantity ?? o.quantidade, 1)));
      const unit = num(o.unit_price ?? o.preco, 0);
      const nm = typeof o.name === "string" ? o.name : typeof o.produto === "string" ? o.produto : "Item";
      return {
        product_id: typeof o.product_id === "string" ? o.product_id : undefined,
        name: nm,
        quantity: qty,
        unit_price: unit,
        line_total: num(o.line_total, unit * qty),
        addons: Array.isArray(o.addons) ? (o.addons as PanelOrder["items"][number]["addons"]) : [],
        notes: typeof o.notes === "string" ? o.notes : undefined,
      };
    }),
    subtotal: num(r.subtotal, num(r.total)),
    delivery_fee: num(r.delivery_fee),
    total: num(r.total),
    payment_method: typeof r.payment_method === "string" ? r.payment_method : "—",
    change_for: typeof r.change_for === "number" ? r.change_for : null,
    notes: typeof r.notes === "string" ? r.notes : null,
    delivery_type:
      typeof r.delivery_type === "string" ? r.delivery_type : null,
    status,
    cancellation_reason:
      typeof r.cancellation_reason === "string" ? r.cancellation_reason : null,
    estimated_delivery_time:
      typeof r.estimated_delivery_time === "string"
        ? r.estimated_delivery_time
        : null,
    estimated_delivery_at:
      typeof r.estimated_delivery_at === "string"
        ? r.estimated_delivery_at
        : null,
    created_at: typeof r.created_at === "string" ? r.created_at : new Date().toISOString(),
    updated_at: typeof r.updated_at === "string" ? r.updated_at : new Date().toISOString(),
  };
}

/**
 * `true` quando a lista consultada é idêntica à atual (mesmos pedidos, status e
 * timestamps). Evita re-renderizar o Kanban a cada ciclo do polling/Realtime
 * quando nada mudou no painel.
 */
function isSameOrderList(current: PanelOrder[], next: PanelOrder[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((order, index) => {
    const other = next[index];
    return (
      order.id === other.id &&
      order.status === other.status &&
      order.created_at === other.created_at &&
      order.updated_at === other.updated_at &&
      order.total === other.total &&
      order.notes === other.notes &&
      order.estimated_delivery_at === other.estimated_delivery_at &&
      order.cancellation_reason === other.cancellation_reason
    );
  });
}

/**
 * Conteúdo interativo da tela de Pedidos do painel (Client Component).
 *
 * A página (`page.tsx`) é um Server Component que exporta `instant = false`
 * (a rota é protegida por sessão no cliente); a interatividade do Kanban
 * vive aqui.
 */
export function PainelPedidos() {
  const { establishments, selectedId, isSuperAdmin, isLoading: isLoadingEst, error: estError, select } = useEstablishment();
  const [orders, setOrders] = useState<PanelOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  // Data selecionada no topo (padrão: hoje no fuso da loja).
  const [selectedDate, setSelectedDate] = useState(() => todayDateValue());
  // Visualização: Kanban (fluxo) ou Lista (tabela). Ambas usam os MESMOS
  // pedidos filtrados pela data selecionada.
  const [view, setView] = useState<"kanban" | "lista">("kanban");
  const supabase = useRef(createClient());
  // Sequência das requisições: descarta respostas fora de ordem quando o
  // usuário troca de data/loja rapidamente (só a última atualiza a tela).
  const requestSeq = useRef(0);
  // Alerta sonoro de novos pedidos (MP3 em /sound/sound.mp3 + ativação manual
  // para liberar o autoplay do navegador).
  const {
    isEnabled: isSoundEnabled,
    isMuted: isSoundMuted,
    error: soundError,
    enableSound,
    toggleMuted,
    playNewOrderSound,
  } = useOrderSoundContext();
  // IDs já vistos por loja/data. A primeira resposta de cada contexto é uma
  // baseline silenciosa: pedidos pendentes que já existiam não disparam o som.
  const orderAlertRef = useRef<{
    context: string;
    seenIds: Set<string>;
    baselineReady: boolean;
  }>({ context: "", seenIds: new Set(), baselineReady: false });

  const fetchOrders = useCallback(
    async (
      establishmentId: string,
      date: string,
      options?: { silent?: boolean }
    ) => {
      /**
       * `silent` = atualização em segundo plano (polling de 15s e Realtime).
       * Nesse modo o estado de loading NÃO é tocado: ele existe apenas na
       * primeira carga, na troca de loja/data e no botão "Atualizar". Sem isso
       * a tela alternava "Atualizando…" a cada ciclo, piscando o conteúdo.
       */
      const silent = options?.silent === true;
      const seq = ++requestSeq.current;
      if (!silent) setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          establishment_id: establishmentId,
        });
        if (date) params.set("date", date);
        const res = await fetch(`/api/orders?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (seq !== requestSeq.current) return;
        if (!res.ok) throw new Error(data.error ?? "Falha ao carregar pedidos.");
        const list: unknown[] = Array.isArray(data.orders) ? data.orders : [];
        const nextOrders = list
          .map(toPanelOrder)
          .filter((o): o is PanelOrder => o !== null);

        // Detecção de novo pedido pendente. O contexto inclui loja e data:
        // trocar o filtro reinicia a baseline sem tocar os pedidos já listados.
        const contextKey = `${establishmentId}:${date}`;
        const alertState = orderAlertRef.current;
        if (alertState.context !== contextKey) {
          alertState.context = contextKey;
          alertState.seenIds = new Set();
          alertState.baselineReady = false;
        }

        // Só alerta IDs que nunca apareceram neste contexto e que chegaram
        // como `pendente`. Acompanhamos TODOS os status para que um pedido que
        // saiu de pendente e voltou não seja tratado como novo.
        const newPendingOrders = alertState.baselineReady
          ? nextOrders.filter(
              (order) =>
                order.status === "pendente" &&
                !alertState.seenIds.has(order.id)
            )
          : [];

        for (const order of nextOrders) {
          alertState.seenIds.add(order.id);
        }
        alertState.baselineReady = true;

        setOrders((prev) =>
          isSameOrderList(prev, nextOrders) ? prev : nextOrders
        );
        if (newPendingOrders.length > 0) playNewOrderSound();
      } catch (err) {
        if (seq !== requestSeq.current) return;
        // Falha no polling não deve zerar a lista já exibida (evita "piscar").
        if (!silent) setOrders([]);
        setError(err instanceof Error ? err.message : "Erro inesperado.");
      } finally {
        if (!silent && seq === requestSeq.current) setIsLoading(false);
      }
    },
    [playNewOrderSound]
  );

  useEffect(() => {
    if (!selectedId) return;
    // IIFE assíncrona: o setState de loading ocorre fora do corpo síncrono
    // do efeito (evita renders em cascata — react-hooks/set-state-in-effect).
    void (async () => {
      await fetchOrders(selectedId, selectedDate);
    })();
  }, [selectedId, selectedDate, fetchOrders]);

  useEffect(() => {
    if (!selectedId) return;
    const id = window.setInterval(
      () => fetchOrders(selectedId, selectedDate, { silent: true }),
      15000
    );
    return () => window.clearInterval(id);
  }, [selectedId, selectedDate, fetchOrders]);

  useEffect(() => {
    if (!selectedId) return;
    const client = supabase.current;
    const channel = client
      .channel(`orders-${selectedId}-${selectedDate}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `establishment_id=eq.${selectedId}`,
        },
        () => fetchOrders(selectedId, selectedDate, { silent: true })
      )
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [selectedId, selectedDate, fetchOrders]);

  /**
   * Atualiza o status via PUT /api/orders (com motivo opcional no cancelamento).
   * A previsão de entrega (min/max) também pode ser enviada junto — o servidor
   * regrava o texto normalizado e o horário previsto a partir de agora.
   * Faz atualização otimista e reverte em caso de erro. Lança o erro para o
   * modal exibir a mensagem sem fechar.
   */
  const updateStatus = useCallback(
    async (
      orderId: string,
      status: OrderStatus,
      cancellationReason?: string,
      estimate?: EstimatedDeliveryWindow
    ) => {
      const previous = orders.find((o) => o.id === orderId);
      setBusyIds((prev) => new Set(prev).add(orderId));
      setFeedback(null);
      setError(null);
      setOrders((cur) =>
        cur.map((o) =>
          o.id === orderId
            ? {
                ...o,
                status,
                // Ao sair de "cancelado" o motivo é limpo (mesma regra da API).
                cancellation_reason:
                  status === "cancelado"
                    ? (cancellationReason ?? o.cancellation_reason ?? null)
                    : null,
                ...(estimate
                  ? {
                      estimated_delivery_time:
                        formatEstimatedDeliveryWindow(estimate),
                      estimated_delivery_at: estimatedDeliveryAtFromNow(estimate),
                    }
                  : {}),
              }
            : o
        )
      );

      try {
        const res = await fetch("/api/orders", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: orderId,
            status,
            ...(cancellationReason
              ? { cancellation_reason: cancellationReason }
              : {}),
            ...(estimate
              ? {
                  estimated_delivery_time_min: estimate.min,
                  estimated_delivery_time_max: estimate.max,
                }
              : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Falha ao atualizar.");

        // Mescla a linha atualizada (valores normalizados) na listagem.
        const saved = toPanelOrder(data.order);
        if (saved) {
          setOrders((cur) => cur.map((o) => (o.id === orderId ? saved : o)));
        }

        let feedbackMessage = `Pedido atualizado para ${ORDER_STATUS_META[status].label}.`;
        if (estimate) {
          feedbackMessage = `Previsão de entrega atualizada para ${formatEstimatedDeliveryWindowLabel(estimate)}.`;
        }
        if (status === "cancelado") {
          feedbackMessage = "Pedido cancelado e motivo registrado.";
        } else if (previous?.status === "cancelado") {
          feedbackMessage = `Pedido reativado como ${ORDER_STATUS_META[status].label}.`;
        }
        setFeedback(feedbackMessage);
      } catch (err) {
        if (previous) {
          setOrders((cur) =>
            cur.map((o) => (o.id === orderId ? previous : o))
          );
        }
        const message = err instanceof Error ? err.message : "Erro inesperado.";
        setError(message);
        throw err;
      } finally {
        setBusyIds((cur) => {
          const next = new Set(cur);
          next.delete(orderId);
          return next;
        });
      }
    },
    [orders]
  );

  /**
   * Ação rápida do card: avança o pedido para a próxima etapa usando a mesma
   * rota `PUT /api/orders` do modal. `updateStatus` já reverte o estado
   * otimista e publica a mensagem de erro no topo do painel.
   */
  const advanceOrderStatus = useCallback(
    (order: PanelOrder, nextStatus: OrderStatus) => {
      void updateStatus(order.id, nextStatus).catch(() => {
        // Erro já tratado e exibido por updateStatus.
      });
    },
    [updateStatus]
  );

  const grouped = useMemo(() => {
    const g = {} as Record<OrderStatus, PanelOrder[]>;
    for (const c of COLUMNS) g[c.status] = [];
    for (const o of orders) {
      const key = normalizeOrderStatus(o.status) ?? "pendente";
      g[key].push(o);
    }
    return g;
  }, [orders]);

  const shortNumbers = useMemo(() => {
    const sorted = [...orders].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const map = new Map<string, string>();
    sorted.forEach((o, i) => map.set(o.id, `#${String(i + 1).padStart(4, "0")}`));
    return map;
  }, [orders]);

  const pendingCount = grouped.pendente.length;

  const selectedOrder = useMemo(
    () => orders.find((o) => o.id === selectedOrderId) ?? null,
    [orders, selectedOrderId]
  );
  const selectedShortNumber = selectedOrder
    ? (shortNumbers.get(selectedOrder.id) ?? `#${selectedOrder.id.slice(0, 8)}`)
    : "";
  const establishmentName =
    establishments.find((e) => e.id === selectedId)?.name ?? "Estabelecimento";

  return (
    <div className="flex min-h-screen flex-col bg-gray-950">
      <AdminHeader establishmentId={selectedId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-white">
              Pedidos em tempo real
              {pendingCount > 0 && (
                <span className="rounded-full bg-yellow-400 px-2.5 py-0.5 text-xs font-bold tabular-nums text-gray-950">
                  {pendingCount} novo{pendingCount > 1 ? "s" : ""}
                </span>
              )}
            </h2>
            <p className="text-sm text-gray-400">
              Pedidos de {formatDateBR(selectedDate)} · alterne entre Kanban e
              Lista e abra os detalhes para gerenciar o pedido.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OrderSoundControl
              isEnabled={isSoundEnabled}
              isMuted={isSoundMuted}
              error={soundError}
              onEnable={enableSound}
              onToggleMute={toggleMuted}
            />
            <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-2.5 py-1.5">
              <label
                htmlFor="orders-date"
                className="text-xs font-semibold uppercase tracking-wider text-gray-500"
              >
                Data
              </label>
              <input
                id="orders-date"
                type="date"
                value={selectedDate}
                onChange={(e) =>
                  setSelectedDate(e.target.value || todayDateValue())
                }
                className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white outline-none [color-scheme:dark] focus:border-yellow-400/60"
              />
              <button
                type="button"
                onClick={() => setSelectedDate(todayDateValue())}
                className="rounded-md px-2 py-1 text-xs font-bold text-yellow-300 transition hover:bg-yellow-400/10"
              >
                Hoje
              </button>
            </div>
            <div
              role="group"
              aria-label="Visualização dos pedidos"
              className="inline-flex overflow-hidden rounded-lg border border-gray-700"
            >
              <button
                type="button"
                onClick={() => setView("kanban")}
                aria-pressed={view === "kanban"}
                className={`px-3 py-2 text-xs font-bold transition ${
                  view === "kanban"
                    ? "bg-yellow-400 text-gray-950"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Kanban
              </button>
              <button
                type="button"
                onClick={() => setView("lista")}
                aria-pressed={view === "lista"}
                className={`px-3 py-2 text-xs font-bold transition ${
                  view === "lista"
                    ? "bg-yellow-400 text-gray-950"
                    : "text-gray-300 hover:bg-gray-800"
                }`}
              >
                Lista
              </button>
            </div>
            {isSuperAdmin && (
              <select
                aria-label="Estabelecimento"
                value={selectedId ?? ""}
                onChange={(e) => select(e.target.value)}
                className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
              >
                {establishments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() =>
                selectedId && fetchOrders(selectedId, selectedDate)
              }
              disabled={!selectedId || isLoading}
              className="rounded-lg border border-gray-700 px-3 py-2 text-sm font-semibold text-gray-300 hover:border-yellow-400/50 hover:text-white disabled:opacity-50"
            >
              {isLoading ? "Atualizando…" : "Atualizar"}
            </button>
          </div>
        </div>

        {feedback && (
          <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            {feedback}
          </p>
        )}
        {(error || estError) && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error ?? estError}
          </p>
        )}
        {(isLoadingEst || (isLoading && orders.length === 0)) && (
          <p className="text-sm text-gray-400">Carregando pedidos…</p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2 xl:grid-cols-5">
          {view === "kanban" ? (
            COLUMNS.map((col) => (
              <KanbanColumn
                key={col.status}
                title={col.title}
                status={col.status}
                orders={grouped[col.status]}
                shortNumbers={shortNumbers}
                onOpenOrder={(order) => setSelectedOrderId(order.id)}
                onAdvanceOrder={advanceOrderStatus}
                busyIds={busyIds}
                highlight={col.highlight}
              />
            ))
          ) : (
            <div className="lg:col-span-2 xl:col-span-5">
              <OrdersTable
                orders={orders}
                shortNumbers={shortNumbers}
                onOpenOrder={(order) => setSelectedOrderId(order.id)}
              />
            </div>
          )}
        </div>
      </main>

      {selectedOrder && (
        <OrderDetailsModal
          key={selectedOrder.id}
          order={selectedOrder}
          shortNumber={selectedShortNumber}
          establishmentName={establishmentName}
          isBusy={busyIds.has(selectedOrder.id)}
          onClose={() => setSelectedOrderId(null)}
          onUpdateStatus={updateStatus}
        />
      )}
    </div>
  );
}
