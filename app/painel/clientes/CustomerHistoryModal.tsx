"use client";

import { useEffect, useState } from "react";
import { ORDER_STATUS_META } from "@/lib/orderStatus";
import { STORE_TIME_ZONE } from "@/lib/openingHours";
import type { CustomerHistory, CustomerSummary } from "@/lib/types";

interface CustomerHistoryModalProps {
  establishmentId: string;
  customer: CustomerSummary;
  onClose: () => void;
}

function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: STORE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatPhone(phone: string | null): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

function whatsappHref(phone: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits.startsWith("55") ? digits : `55${digits}`}`;
}

/**
 * Modal com o resumo acumulado e o histórico completo de pedidos do cliente.
 * Busca os dados sob demanda em GET /api/customers/history?key=...
 */
export function CustomerHistoryModal({
  establishmentId,
  customer,
  onClose,
}: CustomerHistoryModalProps) {
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fecha com ESC e trava o scroll do body enquanto aberto.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          establishment_id: establishmentId,
          key: customer.key,
        });
        const res = await fetch(`/api/customers/history?${params.toString()}`, {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          customer?: CustomerHistory;
          error?: string;
        };
        if (!res.ok || !data.customer) {
          throw new Error(
            data.error ?? "Falha ao carregar o histórico do cliente."
          );
        }
        if (!cancelled) setHistory(data.customer);
      } catch (err) {
        if (!cancelled) {
          setHistory(null);
          setError(err instanceof Error ? err.message : "Erro inesperado.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [establishmentId, customer.key]);

  const summary = history ?? customer;
  const phoneHref = whatsappHref(summary.phone);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Fechar histórico do cliente"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/75 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-history-title"
        className="relative flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-gray-700 bg-gray-900 shadow-2xl sm:max-h-[90vh] sm:rounded-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-gray-800 px-4 py-4 sm:px-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
              Cliente
            </p>
            <h2
              id="customer-history-title"
              className="text-xl font-black tracking-tight text-white"
            >
              {summary.name}
            </h2>
            {phoneHref ? (
              <a
                href={phoneHref}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 inline-block text-xs tabular-nums text-emerald-300 hover:underline"
              >
                {formatPhone(summary.phone)}
              </a>
            ) : (
              <p className="mt-0.5 text-xs text-gray-500">Sem telefone</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {phoneHref && (
              <a
                href={phoneHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-green-700"
              >
                WhatsApp
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-700 text-lg leading-none text-gray-400 transition hover:bg-gray-800 hover:text-white"
            >
              ×
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-gray-800 bg-gray-800/30 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                Faturamento
              </p>
              <p className="mt-1 font-bold tabular-nums text-yellow-300">
                {formatBRL(summary.totalSpent)}
              </p>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-800/30 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                Ticket médio
              </p>
              <p className="mt-1 font-bold tabular-nums text-white">
                {formatBRL(summary.averageTicket)}
              </p>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-800/30 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                Concluídos
              </p>
              <p className="mt-1 font-bold tabular-nums text-white">
                {summary.completedOrders}
              </p>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-800/30 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                Pedidos válidos
              </p>
              <p className="mt-1 font-bold tabular-nums text-white">
                {summary.totalOrders}
              </p>
            </div>
          </div>

          <h3 className="mt-5 text-xs font-bold uppercase tracking-wider text-gray-500">
            Histórico de pedidos
          </h3>

          {isLoading && (
            <p className="mt-3 text-sm text-gray-400">Carregando histórico…</p>
          )}

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
            >
              {error}
            </p>
          )}

          {!isLoading && !error && history && history.orders.length === 0 && (
            <p className="mt-3 rounded-lg border border-dashed border-gray-700 px-3 py-6 text-center text-sm text-gray-500">
              Nenhum pedido encontrado para este cliente.
            </p>
          )}

          {history && history.orders.length > 0 && (
            <ul className="mt-3 flex flex-col gap-3">
              {history.orders.map((order) => {
                const meta = ORDER_STATUS_META[order.status];
                return (
                  <li
                    key={order.id}
                    className="rounded-xl border border-gray-800 bg-gray-800/30 p-3.5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-bold text-white">
                          #{order.id.slice(0, 8).toUpperCase()}
                        </p>
                        <p className="text-xs tabular-nums text-gray-400">
                          {formatDateTime(order.created_at)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${meta.badgeClass}`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`}
                          />
                          {meta.label}
                        </span>
                        <span className="font-bold tabular-nums text-yellow-300">
                          {formatBRL(order.total)}
                        </span>
                      </div>
                    </div>

                    <ul className="mt-2 divide-y divide-gray-800/80 border-t border-gray-800 pt-1">
                      {order.items.map((item, index) => (
                        <li
                          key={`${order.id}-${index}`}
                          className="flex items-start justify-between gap-3 py-1.5 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="text-gray-200">
                              {item.quantity}× {item.name}
                            </p>
                            {(item.addons?.length ?? 0) > 0 && (
                              <p className="text-xs text-gray-500">
                                + {item.addons?.map((a) => a.name).join(", ")}
                              </p>
                            )}
                            {item.notes && (
                              <p className="text-xs italic text-gray-500">
                                Obs: {item.notes}
                              </p>
                            )}
                          </div>
                          <span className="shrink-0 tabular-nums text-gray-300">
                            {formatBRL(item.line_total)}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {order.coupon_code && (
                      <p className="mt-2 text-xs font-semibold text-emerald-400">
                        Cupom {order.coupon_code}
                        {order.coupon_discount
                          ? ` · −${formatBRL(order.coupon_discount)}`
                          : ""}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
