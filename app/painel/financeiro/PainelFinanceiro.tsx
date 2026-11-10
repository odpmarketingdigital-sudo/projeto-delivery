"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useEstablishment } from "@/app/painel/produtos/useEstablishment";
import { PLATFORM_FEE_LABEL } from "@/lib/asaasSubaccount";
import { MONTH_SHORT } from "@/lib/dateRange";
import {
  PAYMENT_STATEMENT_FILTERS,
  PAYMENT_STATUS_META,
  type PaymentStatement,
  type PaymentStatementEntry,
  type PaymentStatementFilter,
} from "@/lib/finance";
import { STORE_TIME_ZONE } from "@/lib/openingHours";

function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

/** Data/hora no fuso da loja (fallback “—” para valores inválidos). */
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

/** Mês de referência (“2026-11”) → “nov/2026”. */
function formatMonth(value: string): string {
  const [year, month] = value.split("-");
  const name = MONTH_SHORT[Number(month) - 1] ?? month;
  return `${name}/${year}`;
}

/** Valor monetário do extrato; pedidos sem pagamento confirmado ficam “—”. */
function moneyCell(entry: PaymentStatementEntry, value: number): string {
  return entry.settled ? formatBRL(value) : "—";
}

/** Card de resumo do topo (total vendido, taxas e saldo líquido). */
function SummaryCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${accent}`}>
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

/** Badge da situação do pagamento online (Pago ✓ / Pendente ⏳ / ...). */
function PaymentBadge({ entry }: { entry: PaymentStatementEntry }) {
  const meta = PAYMENT_STATUS_META[entry.status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${meta.badgeClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
      {meta.label}
    </span>
  );
}

/**
 * Extrato de Pagamentos (Financeiro) do painel.
 *
 * Lista os pedidos com pagamento **online** (PIX Online do Split Asaas) com
 * valor bruto, taxa da plataforma (R$ 0,50 por pedido pago) e líquido do
 * lojista. Os cards do topo fecham o mês corrente (fuso da loja) e a tabela
 * mostra todo o histórico, filtrável por situação do pagamento.
 */
export function PainelFinanceiro() {
  const {
    establishments,
    selectedId,
    isSuperAdmin,
    isLoading: isLoadingEst,
    error: estError,
    select,
  } = useEstablishment();

  const [statement, setStatement] = useState<PaymentStatement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<PaymentStatementFilter>("todos");

  // Descarta respostas fora de ordem quando o estabelecimento muda rápido.
  const requestSeq = useRef(0);

  const fetchStatement = useCallback(async () => {
    if (!selectedId) return;
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/financeiro?establishment_id=${encodeURIComponent(selectedId)}`,
        { cache: "no-store" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        statement?: PaymentStatement;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(
          data.error ?? "Falha ao carregar o extrato de pagamentos."
        );
      }
      if (seq !== requestSeq.current) return;
      setStatement(data.statement ?? null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setStatement(null);
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await fetchStatement();
    })();
    return () => {
      active = false;
    };
  }, [fetchStatement]);

  const orders = useMemo(() => statement?.orders ?? [], [statement]);

  const counters = useMemo(() => {
    let paid = 0;
    let pending = 0;
    for (const entry of orders) {
      if (entry.settled) paid += 1;
      else if (entry.status === "pendente") pending += 1;
    }
    return { all: orders.length, paid, pending };
  }, [orders]);

  const filtered = useMemo(
    () =>
      filter === "todos"
        ? orders
        : orders.filter((entry) => entry.status === filter),
    [orders, filter]
  );

  const summary = statement?.summary ?? null;
  const monthLabel = summary ? formatMonth(summary.month) : "—";
  const countFor = (value: PaymentStatementFilter) =>
    value === "pago"
      ? counters.paid
      : value === "pendente"
        ? counters.pending
        : value === "todos"
          ? counters.all
          : 0;

  return (
    <div className="flex flex-1 flex-col">
      <AdminHeader establishmentId={selectedId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Extrato de Pagamentos
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Pedidos pagos online via PIX, com a taxa da plataforma (
              {PLATFORM_FEE_LABEL} por pedido pago) retida no repasse.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {isSuperAdmin && (
              <div>
                <label
                  htmlFor="financeiro-estabelecimento"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Estabelecimento
                </label>
                <select
                  id="financeiro-estabelecimento"
                  value={selectedId ?? ""}
                  onChange={(e) => select(e.target.value)}
                  disabled={isLoadingEst || establishments.length === 0}
                  className="min-w-56 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500 disabled:opacity-60"
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
              onClick={() => void fetchStatement()}
              disabled={!selectedId || isLoading}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? "Atualizando…" : "Atualizar"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SummaryCard
            label="Total vendido online"
            value={summary ? formatBRL(summary.grossTotal) : "—"}
            hint={`Pedidos pagos em ${monthLabel} · ${
              summary?.paidOrders ?? 0
            } pago(s)`}
            accent="text-slate-900"
          />
          <SummaryCard
            label="Taxas da plataforma"
            value={summary ? formatBRL(summary.feeTotal) : "—"}
            hint={`${PLATFORM_FEE_LABEL} × ${
              summary?.paidOrders ?? 0
            } pedido(s) pago(s) em ${monthLabel}`}
            accent="text-amber-600"
          />
          <SummaryCard
            label="Saldo líquido repassado"
            value={summary ? formatBRL(summary.netTotal) : "—"}
            hint={`Crédito na subconta do lojista · ${
              summary?.pendingOrders ?? 0
            } aguardando pagamento`}
            accent="text-emerald-600"
          />
        </div>

        {(error || estError) && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"
          >
            {error ?? estError}
          </p>
        )}

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Histórico de pagamentos
              </h2>
              <p className="text-xs text-slate-500">
                {filtered.length} pedido(s){" "}
                {filter === "todos"
                  ? "no total"
                  : `com status “${
                      PAYMENT_STATEMENT_FILTERS.find(
                        (option) => option.value === filter
                      )?.label ?? filter
                    }”`}
              </p>
            </div>

            <div
              role="group"
              aria-label="Filtrar por situação do pagamento"
              className="inline-flex rounded-xl bg-slate-100 p-1"
            >
              {PAYMENT_STATEMENT_FILTERS.map((option) => {
                const active = option.value === filter;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setFilter(option.value)}
                    aria-pressed={active}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      active
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {option.label}
                    <span className="ml-1.5 tabular-nums text-slate-400">
                      {countFor(option.value)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {isLoadingEst || (isLoading && orders.length === 0) ? (
            <p className="px-4 py-10 text-center text-sm text-slate-600">
              Carregando extrato de pagamentos…
            </p>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-slate-600">
                {orders.length === 0
                  ? "Nenhum pedido com pagamento online ainda."
                  : "Nenhum pedido com essa situação de pagamento."}
              </p>
              {orders.length === 0 && (
                <p className="mt-1 text-xs text-slate-500">
                  Ative o recebimento online em{" "}
                  <Link
                    href="/painel/configuracoes"
                    className="font-semibold text-amber-600 underline-offset-2 hover:underline"
                  >
                    Configurações → Recebimento Online
                  </Link>{" "}
                  para aceitar PIX direto no checkout.
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Pedido
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Cliente
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-semibold"
                    >
                      Valor bruto
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-semibold"
                    >
                      Taxa ({PLATFORM_FEE_LABEL})
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-semibold"
                    >
                      Líquido
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Pagamento
                    </th>
                    <th scope="col" className="px-4 py-3 font-semibold">
                      Repasse
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry) => {
                    const meta = PAYMENT_STATUS_META[entry.status];
                    return (
                      <tr
                        key={entry.id}
                        className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70"
                      >
                        <td className="px-4 py-3">
                          <p className="font-semibold tabular-nums text-slate-900">
                            {entry.shortNumber}
                          </p>
                          <p className="text-xs text-slate-500">
                            {formatDateTime(entry.created_at)}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-900">
                            {entry.customer_name}
                          </p>
                          <p className="text-xs text-slate-500">
                            {formatPhone(entry.customer_phone)}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                          {formatBRL(entry.gross)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-amber-600">
                          {moneyCell(entry, entry.fee)}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums text-emerald-600">
                          {moneyCell(entry, entry.net)}
                        </td>
                        <td className="px-4 py-3">
                          <PaymentBadge entry={entry} />
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-xs text-slate-600">
                            {meta.settlementLabel}
                          </p>
                          {entry.paid_at && (
                            <p className="text-xs text-slate-400">
                              {formatDateTime(entry.paid_at)}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="text-xs text-slate-500">
          A taxa de {PLATFORM_FEE_LABEL} é retida automaticamente no Split do
          Asaas a cada pedido pago online; o líquido é creditado na subconta do
          lojista. Pedidos pendentes, expirados ou cancelados não geram taxa.
        </p>
      </main>
    </div>
  );
}
