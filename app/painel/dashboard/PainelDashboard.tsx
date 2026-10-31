"use client";

import { useEffect, useMemo, useState } from "react";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useEstablishment } from "@/app/painel/produtos/useEstablishment";
import {
  currentMonthValue,
  currentYearValue,
  formatDateBR,
  todayDateValue,
} from "@/lib/dateRange";
import type { DashboardData, DashboardPeriod } from "@/lib/types";

const PERIOD_OPTIONS: { value: DashboardPeriod; label: string }[] = [
  { value: "day", label: "Dia" },
  { value: "month", label: "Mês" },
  { value: "year", label: "Ano" },
];

function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

function defaultValueFor(period: DashboardPeriod): string {
  if (period === "month") return currentMonthValue();
  if (period === "year") return currentYearValue();
  return todayDateValue();
}

function periodLabel(period: DashboardPeriod, value: string): string {
  if (period === "month") {
    const [year, month] = value.split("-");
    return `${month}/${year}`;
  }
  if (period === "year") return value;
  return formatDateBR(value);
}

export function PainelDashboard() {
  const {
    establishments,
    selectedId,
    isSuperAdmin,
    isLoading: isLoadingEst,
    error: estError,
    select,
  } = useEstablishment();

  const [period, setPeriod] = useState<DashboardPeriod>("day");
  const [value, setValue] = useState(() => todayDateValue());
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentYear = Number(currentYearValue());
  const yearOptions = useMemo(
    () => Array.from({ length: 7 }, (_, index) => String(currentYear - index)),
    [currentYear]
  );

  const handlePeriodChange = (next: DashboardPeriod) => {
    setPeriod(next);
    setValue(defaultValueFor(next));
  };

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;

    // IIFE assíncrona: mantém as atualizações de estado fora do corpo
    // síncrono do efeito (react-hooks/set-state-in-effect).
    void (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          period,
          value,
          establishment_id: selectedId,
        });
        const res = await fetch(`/api/dashboard?${params.toString()}`, {
          cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json.error ?? "Falha ao carregar o dashboard.");
        }
        if (!cancelled) {
          setData(json.dashboard as DashboardData);
        }
      } catch (err) {
        if (!cancelled) {
          setData(null);
          setError(err instanceof Error ? err.message : "Erro inesperado.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedId, period, value]);

  const maxSeriesRevenue = useMemo(() => {
    if (!data) return 0;
    return data.series.reduce(
      (max, point) => Math.max(max, point.revenue),
      0
    );
  }, [data]);

  return (
    <div className="flex flex-1 flex-col">
      <AdminHeader establishmentId={selectedId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Dashboard de Vendas
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Faturamento, ticket médio e evolução das vendas por período.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {isSuperAdmin && (
              <div>
                <label
                  htmlFor="dashboard-establishment"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500"
                >
                  Estabelecimento
                </label>
                <select
                  id="dashboard-establishment"
                  value={selectedId ?? ""}
                  onChange={(event) => select(event.target.value)}
                  className="min-w-48 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900"
                >
                  {establishments.map((establishment) => (
                    <option key={establishment.id} value={establishment.id}>
                      {establishment.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label
                htmlFor="dashboard-period"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500"
              >
                Período
              </label>
              <select
                id="dashboard-period"
                value={period}
                onChange={(event) =>
                  handlePeriodChange(event.target.value as DashboardPeriod)
                }
                className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900"
              >
                {PERIOD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="dashboard-value"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500"
              >
                {period === "day" ? "Data" : period === "month" ? "Mês" : "Ano"}
              </label>
              {period === "day" && (
                <input
                  id="dashboard-value"
                  type="date"
                  value={value}
                  onChange={(event) =>
                    setValue(event.target.value || todayDateValue())
                  }
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none [color-scheme:light] focus:border-amber-500"
                />
              )}
              {period === "month" && (
                <input
                  id="dashboard-value"
                  type="month"
                  value={value}
                  onChange={(event) =>
                    setValue(event.target.value || currentMonthValue())
                  }
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none [color-scheme:light] focus:border-amber-500"
                />
              )}
              {period === "year" && (
                <select
                  id="dashboard-value"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900"
                >
                  {yearOptions.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>

        {(error || estError) && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error ?? estError}
          </p>
        )}

        {(isLoadingEst || isLoading) && (
          <p className="text-sm text-slate-600">Carregando indicadores…</p>
        )}

        {!selectedId && !isLoadingEst && !estError && (
          <p className="text-sm text-slate-600">
            Selecione um estabelecimento para visualizar o dashboard.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <article className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Faturamento
            </p>
            <p className="mt-2 text-2xl font-black tabular-nums text-amber-600">
              {formatBRL(data?.revenue ?? 0)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {periodLabel(period, value)} · pedidos não cancelados
            </p>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Pedidos
            </p>
            <p className="mt-2 text-2xl font-black tabular-nums text-slate-900">
              {data?.orders ?? 0}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Pedidos válidos no período
            </p>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Ticket médio
            </p>
            <p className="mt-2 text-2xl font-black tabular-nums text-emerald-700">
              {formatBRL(data?.averageTicket ?? 0)}
            </p>
            <p className="mt-1 text-xs text-slate-500">Faturamento ÷ pedidos</p>
          </article>
        </div>

        {data && data.canceledOrders > 0 && (
          <p className="text-xs text-slate-500">
            {data.canceledOrders} pedido
            {data.canceledOrders > 1 ? "s" : ""} cancelado
            {data.canceledOrders > 1 ? "s" : ""} não entra
            {data.canceledOrders > 1 ? "m" : ""} nos indicadores.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <article className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
              Dia de maior venda
            </p>
            {data?.topDay ? (
              <>
                <p className="mt-2 text-xl font-black text-slate-900">
                  {data.topDay.label}
                </p>
                <p className="mt-1 text-sm text-emerald-700">
                  {formatBRL(data.topDay.revenue)} · {data.topDay.orders} pedido
                  {data.topDay.orders > 1 ? "s" : ""}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                Sem vendas no período selecionado.
              </p>
            )}
          </article>

          <article className="rounded-2xl border border-slate-300 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">
              Dia de menor venda
            </p>
            {data?.bottomDay ? (
              <>
                <p className="mt-2 text-xl font-black text-slate-900">
                  {data.bottomDay.label}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {formatBRL(data.bottomDay.revenue)} · {data.bottomDay.orders}{" "}
                  pedido{data.bottomDay.orders > 1 ? "s" : ""}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-600">
                Sem vendas no período selecionado.
              </p>
            )}
          </article>
        </div>

        {data?.topDay &&
          data?.bottomDay &&
          data.topDay.date === data.bottomDay.date && (
            <p className="-mt-2 text-xs text-slate-500">
              Apenas um dia com vendas no período — maior e menor venda
              coincidem.
            </p>
          )}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold text-slate-900">Evolução das vendas</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                {period === "day"
                  ? "Faturamento por hora"
                  : period === "month"
                    ? "Faturamento por dia"
                    : "Faturamento por mês"}
              </p>
            </div>
            <span className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700">
              {periodLabel(period, value)}
            </span>
          </div>

          {data && data.orders > 0 ? (
            <div className="mt-4 overflow-x-auto pb-1">
              <div className="flex h-56 min-w-full items-end gap-1.5">
                {data.series.map((point) => {
                  const height =
                    maxSeriesRevenue > 0
                      ? Math.max(
                          point.revenue > 0 ? 4 : 2,
                          (point.revenue / maxSeriesRevenue) * 100
                        )
                      : 2;
                  return (
                    <div
                      key={point.key}
                      title={`${point.label}: ${formatBRL(point.revenue)} · ${
                        point.orders
                      } pedido${point.orders > 1 ? "s" : ""}`}
                      className="group flex min-w-[16px] flex-1 flex-col items-center gap-1"
                    >
                      <div className="flex h-40 w-full items-end">
                        <div
                          className={`w-full rounded-t transition ${
                            point.revenue > 0
                              ? "bg-yellow-400 group-hover:bg-yellow-300"
                              : "bg-slate-200"
                          }`}
                          style={{ height: `${height}%` }}
                        />
                      </div>
                      <span className="whitespace-nowrap text-[9px] text-slate-500">
                        {point.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
              Nenhuma venda registrada para {periodLabel(period, value)}.
            </p>
          )}
        </section>
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">
              Resumo por {period === "day" ? "hora" : period === "month" ? "dia" : "mês"}
            </h2>
            <span className="text-xs text-slate-500">
              {data?.orders ?? 0} pedido{(data?.orders ?? 0) === 1 ? "" : "s"} ·{" "}
              {formatBRL(data?.revenue ?? 0)}
            </span>
          </div>

          {data && data.series.length > 0 ? (
            <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3.5 py-2.5 font-semibold">Período</th>
                    <th className="px-3.5 py-2.5 text-right font-semibold">
                      Pedidos
                    </th>
                    <th className="px-3.5 py-2.5 text-right font-semibold">
                      Faturamento
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.series.map((point) => (
                    <tr
                      key={point.key}
                      className={
                        point.orders > 0 ? "text-slate-700" : "text-slate-500"
                      }
                    >
                      <td className="px-3.5 py-2">{point.label}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums">
                        {point.orders}
                      </td>
                      <td className="px-3.5 py-2 text-right font-semibold tabular-nums">
                        {formatBRL(point.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">
              Sem dados para o período selecionado.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
