"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useEstablishment } from "@/app/painel/produtos/useEstablishment";
import { STORE_TIME_ZONE } from "@/lib/openingHours";
import type { CustomerSummary } from "@/lib/types";
import { CustomerHistoryModal } from "./CustomerHistoryModal";

function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

/** Data/hora do último pedido no fuso da loja. */
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

/** Telefone salvo sem máscara → (DD) 99999-9999 (fallback: valor original). */
function formatPhone(phone: string | null): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

/** Link do WhatsApp com DDI 55 quando o número ainda não o possui. */
function whatsappHref(phone: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits.startsWith("55") ? digits : `55${digits}`}`;
}

/** Normaliza texto da busca (sem acentos, caixa baixa). */
function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Gestão e histórico de clientes do painel.
 *
 * A lista é agregada a partir dos pedidos da loja (GET
 * /api/customers/history), portanto funciona mesmo sem a tabela `customers`.
 * A busca filtra em tempo real por nome ou telefone; clicar no cliente abre o
 * modal com o histórico completo de pedidos.
 */
export function PainelClientes() {
  const {
    establishments,
    selectedId,
    isSuperAdmin,
    isLoading: isLoadingEst,
    error: estError,
    select,
  } = useEstablishment();

  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerSummary | null>(null);

  // Descarta respostas fora de ordem quando o estabelecimento muda rápido.
  const requestSeq = useRef(0);

  const fetchCustomers = useCallback(async () => {
    if (!selectedId) return;
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/customers/history?establishment_id=${encodeURIComponent(
          selectedId
        )}`,
        { cache: "no-store" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        customers?: CustomerSummary[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao carregar os clientes.");
      }
      if (seq !== requestSeq.current) return;
      setCustomers(data.customers ?? []);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setCustomers([]);
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await fetchCustomers();
    })();
    return () => {
      active = false;
    };
  }, [fetchCustomers]);

  const filtered = useMemo(() => {
    const term = normalizeSearch(query);
    if (!term) return customers;
    const digits = query.replace(/\D/g, "");
    return customers.filter((customer) => {
      const nameMatch = normalizeSearch(customer.name).includes(term);
      const phoneMatch =
        digits.length > 0 && (customer.phone ?? "").includes(digits);
      return nameMatch || phoneMatch;
    });
  }, [customers, query]);

  const summary = useMemo(
    () => ({
      customers: customers.length,
      orders: customers.reduce((sum, c) => sum + c.totalOrders, 0),
      revenue: customers.reduce((sum, c) => sum + c.totalSpent, 0),
    }),
    [customers]
  );

  return (
    <div className="flex min-h-screen flex-col bg-gray-950">
      <AdminHeader establishmentId={selectedId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Clientes
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Clientes que já pediram na loja, com histórico e faturamento.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor="clientes-busca"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500"
              >
                Buscar
              </label>
              <input
                id="clientes-busca"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Nome ou telefone"
                className="w-64 rounded-xl border border-gray-800 bg-gray-900/50 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60"
              />
            </div>

            {isSuperAdmin && (
              <div>
                <label
                  htmlFor="clientes-estabelecimento"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500"
                >
                  Estabelecimento
                </label>
                <select
                  id="clientes-estabelecimento"
                  value={selectedId ?? ""}
                  onChange={(e) => select(e.target.value)}
                  disabled={isLoadingEst || establishments.length === 0}
                  className="min-w-56 rounded-xl border border-gray-800 bg-gray-900/50 px-3 py-2.5 text-sm text-gray-200 outline-none transition focus:border-yellow-400/60 disabled:opacity-60"
                >
                  {establishments.map((est) => (
                    <option key={est.id} value={est.id}>
                      {est.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              type="button"
              onClick={() => void fetchCustomers()}
              disabled={!selectedId || isLoading}
              className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? "Atualizando…" : "Atualizar"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Clientes
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-white">
              {summary.customers}
            </p>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Pedidos válidos
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-white">
              {summary.orders}
            </p>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Faturamento acumulado
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-yellow-300">
              {formatBRL(summary.revenue)}
            </p>
          </div>
        </div>

        {(error || estError) && (
          <p
            role="alert"
            className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            {error ?? estError}
          </p>
        )}

        {isLoadingEst || (isLoading && customers.length === 0) ? (
          <p className="text-sm text-gray-400">Carregando clientes…</p>
        ) : filtered.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-700 px-4 py-10 text-center text-sm text-gray-500">
            {customers.length === 0
              ? "Nenhum cliente com pedidos nesta loja ainda."
              : "Nenhum cliente encontrado para a busca."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-700/60">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-gray-800/70 text-[11px] uppercase tracking-wider text-gray-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-bold">
                    Nome
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    Telefone / WhatsApp
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    Pedidos
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    Faturamento total
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    Último pedido
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    Ações
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {filtered.map((customer) => {
                  const href = whatsappHref(customer.phone);
                  return (
                    <tr key={customer.key} className="hover:bg-gray-800/40">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setSelectedCustomer(customer)}
                          className="rounded-md text-left font-semibold text-white transition hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
                        >
                          {customer.name}
                        </button>
                        {customer.canceledOrders > 0 && (
                          <p className="text-xs text-red-300/80">
                            {customer.canceledOrders} cancelado
                            {customer.canceledOrders > 1 ? "s" : ""}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Abrir conversa no WhatsApp"
                            className="font-medium tabular-nums text-emerald-300 transition hover:text-emerald-200 hover:underline"
                          >
                            {formatPhone(customer.phone)}
                          </a>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-300">
                        {customer.totalOrders}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums text-yellow-300">
                        {formatBRL(customer.totalSpent)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-gray-400">
                        {formatDateTime(customer.lastOrderAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedCustomer(customer)}
                          className="rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-1.5 text-xs font-bold text-gray-200 transition hover:border-yellow-400/50 hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
                        >
                          Ver histórico
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {selectedCustomer && selectedId && (
          <CustomerHistoryModal
            establishmentId={selectedId}
            customer={selectedCustomer}
            onClose={() => setSelectedCustomer(null)}
          />
        )}
      </main>
    </div>
  );
}
