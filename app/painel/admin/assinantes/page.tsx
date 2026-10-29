"use client";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useAuth } from "@/context/AuthContext";
import {
  MANUAL_ACTIVATION_DAYS,
  TRIAL_EXTENSION_DAYS,
  type SubscriptionStatus,
} from "@/lib/subscriptions";

/** Tamanho da página (o teto da API é 50). */
const PAGE_SIZE = 20;

/** Linha devolvida por `GET /api/admin/subscriptions`. */
interface SubscriberRow {
  id: string;
  name: string | null;
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  status: string | null;
  subscription_status: SubscriptionStatus | null;
  trial_ends_at: string | null;
  plan_id: string | null;
  subscription_id: string | null;
  customer_payment_id: string | null;
  created_at: string | null;
}

/** Metadados de paginação da API. */
interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface SubscribersResponse {
  establishments: SubscriberRow[];
  pagination: Pagination;
  schemaPending?: boolean;
}

type StatusFilter = "todos" | SubscriptionStatus;

/** Ações rápidas suportadas por `PATCH /api/admin/subscriptions`. */
type RowAction = "activate" | "extend_trial" | "cancel";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "todos", label: "Todos os status" },
  { value: "active", label: "Ativo" },
  { value: "trialing", label: "Em período de testes" },
  { value: "past_due", label: "Inadimplente" },
  { value: "canceled", label: "Cancelado" },
];

/** Badges por status: verde, azul, amarelo e vermelho. */
const STATUS_BADGES: Record<
  SubscriptionStatus,
  { label: string; className: string; dotClassName: string }
> = {
  active: {
    label: "Ativo",
    className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    dotClassName: "bg-emerald-400",
  },
  trialing: {
    label: "Em Teste",
    className: "border-sky-500/40 bg-sky-500/15 text-sky-300",
    dotClassName: "bg-sky-400",
  },
  past_due: {
    label: "Inadimplente",
    className: "border-yellow-400/40 bg-yellow-400/15 text-yellow-300",
    dotClassName: "bg-yellow-400",
  },
  canceled: {
    label: "Cancelado",
    className: "border-red-500/40 bg-red-500/15 text-red-300",
    dotClassName: "bg-red-400",
  },
};

/** Converte um ISO em `dd/mm/aaaa` (null quando ausente/inválido). */
function formatDate(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString("pt-BR");
}

/** Dias restantes até a data (negativo quando já venceu). */
function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

/** Link do WhatsApp a partir do número cadastrado (somente dígitos). */
function whatsappHref(row: SubscriberRow): string | null {
  const raw = row.whatsapp || row.phone;
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `https://wa.me/${digits.startsWith("55") ? digits : `55${digits}`}`;
}

/** Rótulo/data exibido na coluna "Vencimento / Fim do Trial". */
function expiryInfo(row: SubscriberRow): { label: string; date: string | null } {
  const date = formatDate(row.trial_ends_at);

  if (row.subscription_status === "active") {
    return { label: "Vence em", date };
  }

  if (row.subscription_status === "canceled") {
    return { label: "Encerrado em", date };
  }

  if (row.subscription_status === "past_due") {
    return { label: "Venceu em", date };
  }

  return { label: "Trial até", date };
}

/**
 * Controle de assinantes (`/painel/admin/assinantes`).
 *
 * Exclusiva do Super Admin. Lista todas as lojas com os dados de cobrança e
 * permite ações manuais via `PATCH /api/admin/subscriptions`:
 *  - "Ativar": `active` + vencimento renovado por 30 dias (Pix direto/cortesia);
 *  - "+15 dias": prorroga o trial mantendo `trialing`;
 *  - "Bloquear": `canceled` (o paywall bloqueia o painel da loja).
 *
 * Busca, filtro de status e paginação são resolvidos na API (server-side).
 */
export default function AdminAssinantesPage() {
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  const [rows, setRows] = useState<SubscriberRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: PAGE_SIZE,
    total: 0,
    totalPages: 0,
  });

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos");
  const [page, setPage] = useState(1);
  // Incrementado quando o filtro muda sem alterar `page` (ex.: F5 manual).
  const [reloadKey, setReloadKey] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [schemaPending, setSchemaPending] = useState(false);

  // Chave `${id}:${action}` da ação em andamento (desabilita os botões da linha).
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SubscriberRow | null>(null);

  /** Consulta paginada na API (search/filtro/ordem resolvidos no servidor). */
  const fetchSubscribers = useCallback(
    async (targetPage: number) => {
      const params = new URLSearchParams({
        page: String(targetPage),
        pageSize: String(PAGE_SIZE),
      });

      if (search) params.set("search", search);
      if (statusFilter !== "todos") params.set("status", statusFilter);

      const res = await fetch(
        `/api/admin/subscriptions?${params.toString()}`,
        { cache: "no-store" }
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          data.error || "Não foi possível carregar os assinantes."
        );
      }

      return data as SubscribersResponse;
    },
    [search, statusFilter]
  );

  // Carrega a página atual sempre que a busca/filtro/página mudam.
  useEffect(() => {
    let active = true;

    (async () => {
      setIsLoading(true);
      try {
        const data = await fetchSubscribers(page);
        if (!active) return;
        setRows(data.establishments);
        setPagination(data.pagination);
        setSchemaPending(Boolean(data.schemaPending));
        setLoadError(null);
      } catch (error) {
        if (!active) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Não foi possível carregar os assinantes."
        );
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [fetchSubscribers, page, reloadKey]);

  /** Aplica a busca digitada (sempre voltando para a primeira página). */
  const handleSearch = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSearch(searchInput.trim());
      setPage(1);
      setReloadKey((key) => key + 1);
    },
    [searchInput]
  );

  /** Limpa busca e filtro de status. */
  const clearFilters = useCallback(() => {
    setSearchInput("");
    setSearch("");
    setStatusFilter("todos");
    setPage(1);
    setReloadKey((key) => key + 1);
  }, []);

  /** Troca o filtro de status (resetando a paginação). */
  const handleStatusChange = useCallback((value: StatusFilter) => {
    setStatusFilter(value);
    setPage(1);
    setReloadKey((key) => key + 1);
  }, []);

  /** Executa uma ação manual e recarrega a lista. */
  const runAction = useCallback(
    async (row: SubscriberRow, action: RowAction) => {
      const key = `${row.id}:${action}`;
      setPendingKey(key);
      setActionError(null);
      setNotice(null);

      try {
        const res = await fetch("/api/admin/subscriptions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: row.id, action }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(
            data.error || "Não foi possível atualizar a assinatura."
          );
        }

        setNotice(data.message ?? "Assinatura atualizada.");

        const refreshed = await fetchSubscribers(page);

        // A ação pode remover a única linha da página (ex.: filtro "Ativo" +
        // cancelamento): volta uma página para não exibir vazio.
        if (refreshed.establishments.length === 0 && page > 1) {
          setPage(page - 1);
        } else {
          setRows(refreshed.establishments);
          setPagination(refreshed.pagination);
        }
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Não foi possível atualizar a assinatura."
        );
      } finally {
        setPendingKey(null);
      }
    },
    [fetchSubscribers, page]
  );

  const hasFilters = search.length > 0 || statusFilter !== "todos";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AdminHeader establishmentId={null} isSuperAdmin={isSuperAdmin} />

      <main className="px-4 py-8 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <nav className="mb-3 flex flex-wrap items-center gap-3 text-sm font-semibold">
                <Link
                  href="/painel/admin"
                  className="text-gray-400 transition hover:text-white"
                >
                  ← Estabelecimentos
                </Link>
                <span aria-hidden="true" className="text-gray-700">
                  |
                </span>
                <Link
                  href="/painel/admin/configuracoes"
                  className="text-yellow-300 transition hover:text-yellow-200"
                >
                  Preço do plano
                </Link>
                <span aria-hidden="true" className="text-gray-700">
                  |
                </span>
                <Link
                  href="/painel/admin/cupons"
                  className="text-gray-400 transition hover:text-white"
                >
                  Cupons de assinatura
                </Link>
              </nav>

              <h1 className="text-3xl font-bold tracking-tight text-white">
                Assinantes
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-gray-400">
                Acompanhe a cobrança de cada loja e libere, prorrogue ou bloqueie
                o acesso manualmente (Pix direto, dinheiro ou cortesia).
              </p>
            </div>

            <Link
              href="/painel/admin/configuracoes"
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-yellow-400/40 bg-yellow-400/10 px-4 py-2.5 text-sm font-bold text-yellow-200 transition hover:bg-yellow-400/20"
            >
              Configurar preço
            </Link>
          </header>

          {/* Filtros: busca + status */}
          <section className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
            <form onSubmit={handleSearch} className="flex flex-1 gap-2">
              <div className="relative flex-1">
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
                  />
                </svg>
                <input
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Buscar por loja, responsável ou e-mail..."
                  aria-label="Buscar assinantes"
                  className="w-full rounded-xl border border-gray-800 bg-gray-900/50 py-2.5 pl-10 pr-3 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60"
                />
              </div>
              <button
                type="submit"
                className="shrink-0 rounded-xl bg-gray-800 px-4 py-2.5 text-sm font-bold text-gray-100 transition hover:bg-gray-700"
              >
                Buscar
              </button>
            </form>

            <select
              aria-label="Filtrar por status da assinatura"
              value={statusFilter}
              onChange={(event) =>
                handleStatusChange(event.target.value as StatusFilter)
              }
              className="rounded-xl border border-gray-800 bg-gray-900/50 px-3 py-2.5 text-sm text-gray-200 outline-none transition focus:border-yellow-400/60 lg:w-56"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="shrink-0 rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:bg-gray-800"
              >
                Limpar filtros
              </button>
            )}
          </section>

          {schemaPending && (
            <p className="mb-4 rounded-xl border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-200">
              As colunas de assinatura ainda não existem no banco. Execute a
              migração{" "}
              <code className="font-mono text-xs">
                20261110000012_add_subscriptions_to_establishments.sql
              </code>{" "}
              para habilitar o controle de status e vencimento.
            </p>
          )}

          {actionError && (
            <div
              role="alert"
              className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3"
            >
              <p className="text-sm font-medium text-red-200">{actionError}</p>
              <button
                type="button"
                onClick={() => setActionError(null)}
                aria-label="Fechar aviso de erro"
                className="text-red-300 transition hover:text-red-200"
              >
                ✕
              </button>
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3"
            >
              <p className="text-sm font-medium text-emerald-200">{notice}</p>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Fechar aviso"
                className="text-emerald-300 transition hover:text-emerald-200"
              >
                ✕
              </button>
            </div>
          )}

          {isLoading ? (
            <div className="space-y-2" aria-busy="true" aria-live="polite">
              {Array.from({ length: 5 }).map((_, index) => (
                <div
                  key={index}
                  className="h-16 animate-pulse rounded-xl border border-gray-800 bg-gray-900/60"
                />
              ))}
            </div>
          ) : loadError ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
              <p className="text-sm font-semibold text-red-200">{loadError}</p>
              <button
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
                className="mt-4 rounded-xl border border-red-400/40 px-4 py-2 text-sm font-bold text-red-200 transition hover:bg-red-500/15"
              >
                Tentar novamente
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-2xl border border-gray-800 bg-gray-900/50 p-10 text-center">
              <p className="text-base font-semibold text-white">
                {hasFilters
                  ? "Nenhum assinante encontrado"
                  : "Nenhuma loja cadastrada"}
              </p>
              <p className="mt-1 text-sm text-gray-400">
                {hasFilters
                  ? "Ajuste a busca ou o filtro de status para ver outros resultados."
                  : "As lojas aparecem aqui assim que o cadastro é concluído."}
              </p>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="mt-4 rounded-xl border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-200 transition hover:bg-gray-800"
                >
                  Limpar filtros
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/50">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="border-b border-gray-800 bg-gray-900/80 text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-semibold">
                        Loja
                      </th>
                      <th scope="col" className="px-4 py-3 font-semibold">
                        Responsável
                      </th>
                      <th scope="col" className="px-4 py-3 font-semibold">
                        WhatsApp
                      </th>
                      <th scope="col" className="px-4 py-3 font-semibold">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-3 font-semibold">
                        Vencimento / Trial
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-3 text-right font-semibold"
                      >
                        Ações
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-gray-800/80">
                    {rows.map((row) => {
                      const status = row.subscription_status;
                      const badge = status ? STATUS_BADGES[status] : null;
                      const expiry = expiryInfo(row);
                      const remaining = daysUntil(row.trial_ends_at);
                      const wa = whatsappHref(row);
                      const phoneLabel = row.whatsapp || row.phone;
                      const isPending = (action: RowAction) =>
                        pendingKey === `${row.id}:${action}`;
                      const isRowPending =
                        pendingKey?.startsWith(`${row.id}:`) ?? false;

                      return (
                        <tr
                          key={row.id}
                          className="align-top transition hover:bg-gray-900/70"
                        >
                          <td className="px-4 py-4">
                            <p className="font-semibold text-white">
                              {row.name || "—"}
                            </p>
                            <p className="mt-0.5 text-xs text-gray-500">
                              {row.email || "sem e-mail"}
                            </p>
                          </td>

                          <td className="px-4 py-4 text-gray-300">
                            {row.owner_name || "—"}
                          </td>

                          <td className="px-4 py-4">
                            {phoneLabel ? (
                              wa ? (
                                <a
                                  href={wa}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium text-emerald-300 transition hover:text-emerald-200"
                                >
                                  {phoneLabel}
                                </a>
                              ) : (
                                <span className="text-gray-300">
                                  {phoneLabel}
                                </span>
                              )
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>

                          <td className="px-4 py-4">
                            {badge ? (
                              <>
                                <span
                                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${badge.className}`}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={`h-1.5 w-1.5 rounded-full ${badge.dotClassName}`}
                                  />
                                  {badge.label}
                                </span>
                                <p className="mt-1.5 text-xs text-gray-500">
                                  {status === "trialing" &&
                                  remaining !== null &&
                                  remaining >= 0
                                    ? `${remaining} ${
                                        remaining === 1
                                          ? "dia restante"
                                          : "dias restantes"
                                      }`
                                    : status === "active"
                                      ? "Assinatura em dia"
                                      : status === "past_due"
                                        ? "Pagamento não identificado"
                                        : "Acesso bloqueado"}
                                </p>
                              </>
                            ) : (
                              <span className="inline-flex items-center rounded-full border border-gray-700 bg-gray-800/60 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-gray-400">
                                Sem assinatura
                              </span>
                            )}
                          </td>

                          <td className="px-4 py-4">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                              {expiry.label}
                            </p>
                            <p className="mt-0.5 font-semibold text-gray-200">
                              {expiry.date ?? "—"}
                            </p>
                          </td>

                          <td className="px-4 py-4">
                            <div className="flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => void runAction(row, "activate")}
                                disabled={isRowPending}
                                title={`Ativar assinatura por ${MANUAL_ACTIVATION_DAYS} dias (pagamento direto/cortesia)`}
                                className="rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {isPending("activate")
                                  ? "Ativando..."
                                  : `Ativar ${MANUAL_ACTIVATION_DAYS} dias`}
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  void runAction(row, "extend_trial")
                                }
                                disabled={isRowPending}
                                title={`Prorrogar o período de testes por ${TRIAL_EXTENSION_DAYS} dias`}
                                className="rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-xs font-bold text-sky-300 transition hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {isPending("extend_trial")
                                  ? "Prorrogando..."
                                  : `Trial +${TRIAL_EXTENSION_DAYS} dias`}
                              </button>

                              <button
                                type="button"
                                onClick={() => setCancelTarget(row)}
                                disabled={isRowPending}
                                title="Bloquear o acesso da loja imediatamente"
                                className="rounded-lg bg-red-500/15 px-2.5 py-1.5 text-xs font-bold text-red-300 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Bloquear
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col items-center justify-between gap-3 border-t border-gray-800 px-4 py-3 sm:flex-row">
                <p className="text-xs text-gray-500">
                  {pagination.total === 1
                    ? "1 assinante"
                    : `${pagination.total} assinantes`}
                  {" · "}
                  página {pagination.page} de {Math.max(pagination.totalPages, 1)}
                </p>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={isLoading || pagination.page <= 1}
                    className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-bold text-gray-300 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ← Anterior
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((current) => current + 1)}
                    disabled={
                      isLoading || pagination.page >= pagination.totalPages
                    }
                    className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-bold text-gray-300 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Próxima →
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Confirmação de bloqueio */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 px-4 py-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-subscription-title"
            className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-6 shadow-2xl"
          >
            <h2
              id="cancel-subscription-title"
              className="text-lg font-bold text-white"
            >
              Bloquear assinante?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              O acesso de{" "}
              <strong className="text-gray-200">
                {cancelTarget.name || "esta loja"}
              </strong>{" "}
              será bloqueado imediatamente (status{" "}
              <code className="font-mono text-xs text-gray-300">canceled</code>).
              Você pode reativar depois pela ação{" "}
              <strong className="text-gray-200">Ativar</strong>.
            </p>

            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setCancelTarget(null)}
                disabled={pendingKey !== null}
                className="rounded-xl border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Manter assinatura
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = cancelTarget;
                  setCancelTarget(null);
                  void runAction(target, "cancel");
                }}
                disabled={pendingKey !== null}
                className="rounded-xl bg-red-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Bloquear acesso
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
