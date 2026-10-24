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
import {
  couponDiscountLabel,
  formatCouponBRL,
  toCouponNumber,
  type CouponRecord,
} from "@/lib/coupons";
import { CouponFormModal } from "./CouponFormModal";
import { DeleteCouponModal } from "./DeleteCouponModal";

/** Data de criação do cupom (fuso da loja). */
function formatDate(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: STORE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

/**
 * Gestão de cupons de desconto do painel.
 *
 * Lista os cupons do estabelecimento e permite criar, editar, ativar/desativar
 * e excluir (rotas /api/coupons). A validação no checkout usa
 * POST /api/coupons/validate e a aplicação final acontece em /api/orders.
 */
export function PainelCupons() {
  const {
    establishments,
    selectedId,
    isSuperAdmin,
    isLoading: isLoadingEst,
    error: estError,
    select,
  } = useEstablishment();

  const [coupons, setCoupons] = useState<CouponRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<CouponRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CouponRecord | null>(null);

  // Descarta respostas fora de ordem quando o estabelecimento muda rápido.
  const requestSeq = useRef(0);

  const fetchCoupons = useCallback(async () => {
    if (!selectedId) return;
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/coupons?establishment_id=${encodeURIComponent(selectedId)}`,
        { cache: "no-store" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        coupons?: CouponRecord[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao carregar os cupons.");
      }
      if (seq !== requestSeq.current) return;
      setCoupons(data.coupons ?? []);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setCoupons([]);
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await fetchCoupons();
    })();
    return () => {
      active = false;
    };
  }, [fetchCoupons]);

  const openCreate = () => {
    setEditingCoupon(null);
    setError(null);
    setFeedback(null);
    setIsFormOpen(true);
  };

  const openEdit = (coupon: CouponRecord) => {
    setEditingCoupon(coupon);
    setError(null);
    setFeedback(null);
    setIsFormOpen(true);
  };

  const handleFormDone = () => {
    setIsFormOpen(false);
    setEditingCoupon(null);
    setFeedback("Cupom salvo com sucesso.");
    void fetchCoupons();
  };

  const handleDelete = useCallback(async (coupon: CouponRecord) => {
    const res = await fetch("/api/coupons", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: coupon.id }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? "Falha ao excluir o cupom.");
    }
    setCoupons((prev) => prev.filter((item) => item.id !== coupon.id));
    setDeleteTarget(null);
    setFeedback("Cupom excluído com sucesso.");
  }, []);

  /** Ativa/desativa rapidamente um cupom via PUT parcial. */
  const handleToggleActive = useCallback(async (coupon: CouponRecord) => {
    setError(null);
    setFeedback(null);
    try {
      const res = await fetch("/api/coupons", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: coupon.id, active: !coupon.active }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        coupon?: CouponRecord;
        error?: string;
      };
      if (!res.ok || !data.coupon) {
        throw new Error(data.error ?? "Falha ao atualizar o status do cupom.");
      }
      const updated = data.coupon;
      setCoupons((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
      setFeedback(
        updated.active
          ? `Cupom ${updated.code} ativado.`
          : `Cupom ${updated.code} desativado.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    }
  }, []);

  const summary = useMemo(
    () => ({
      active: coupons.filter((coupon) => coupon.active).length,
      uses: coupons.reduce(
        (sum, coupon) => sum + toCouponNumber(coupon.used_count),
        0
      ),
    }),
    [coupons]
  );

  return (
    <div className="flex min-h-screen flex-col bg-gray-950">
      <AdminHeader establishmentId={selectedId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Cupons de desconto
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Crie códigos promocionais, defina limites de uso e acompanhe a
              utilização no checkout.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {isSuperAdmin && (
              <div>
                <label
                  htmlFor="cupons-estabelecimento"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500"
                >
                  Estabelecimento
                </label>
                <select
                  id="cupons-estabelecimento"
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
              onClick={() => void fetchCoupons()}
              disabled={!selectedId || isLoading}
              className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? "Atualizando…" : "Atualizar"}
            </button>

            <button
              type="button"
              onClick={openCreate}
              disabled={!selectedId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Novo cupom
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Cupons ativos
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-white">
              {summary.active}
            </p>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Total de cupons
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-white">
              {coupons.length}
            </p>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Usos acumulados
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-yellow-300">
              {summary.uses}
            </p>
          </div>
        </div>

        {feedback && (
          <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {feedback}
          </p>
        )}
        {(error || estError) && (
          <p
            role="alert"
            className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            {error ?? estError}
          </p>
        )}

        {isLoadingEst || (isLoading && coupons.length === 0) ? (
          <p className="text-sm text-gray-400">Carregando cupons…</p>
        ) : coupons.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-700 px-4 py-10 text-center text-sm text-gray-500">
            Nenhum cupom cadastrado. Crie o primeiro em “Novo cupom”.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-700/60">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="bg-gray-800/70 text-[11px] uppercase tracking-wider text-gray-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-bold">
                    Código
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    Desconto
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    Pedido mínimo
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    Usos
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-bold">
                    Criado em
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-bold">
                    Ações
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {coupons.map((coupon) => {
                  const minOrder =
                    coupon.min_order_value == null
                      ? 0
                      : toCouponNumber(coupon.min_order_value);
                  const limit =
                    coupon.usage_limit == null
                      ? null
                      : toCouponNumber(coupon.usage_limit);
                  const used = toCouponNumber(coupon.used_count);

                  return (
                    <tr key={coupon.id} className="hover:bg-gray-800/40">
                      <td className="whitespace-nowrap px-4 py-3">
                        <code className="rounded-md bg-gray-800 px-2 py-1 font-mono text-sm font-bold text-yellow-300">
                          {coupon.code}
                        </code>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-gray-200">
                        {couponDiscountLabel({
                          discount_type: coupon.discount_type,
                          discount_value: toCouponNumber(coupon.discount_value),
                        })}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-300">
                        {minOrder > 0 ? formatCouponBRL(minOrder) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-gray-300">
                        {used} / {limit ?? "∞"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${
                            coupon.active
                              ? "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30"
                              : "bg-gray-700/40 text-gray-400 ring-gray-600/40"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              coupon.active ? "bg-emerald-400" : "bg-gray-500"
                            }`}
                          />
                          {coupon.active ? "Ativo" : "Inativo"}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-gray-400">
                        {formatDate(coupon.created_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEdit(coupon)}
                            className="rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-1.5 text-xs font-bold text-gray-200 transition hover:border-yellow-400/50 hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleActive(coupon)}
                            className="rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-1.5 text-xs font-bold text-gray-200 transition hover:border-emerald-400/50 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
                          >
                            {coupon.active ? "Desativar" : "Ativar"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(coupon)}
                            className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-300 transition hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-red-400/40"
                          >
                            Excluir
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {isFormOpen && selectedId && (
        <CouponFormModal
          establishmentId={selectedId}
          isSuperAdmin={isSuperAdmin}
          editing={editingCoupon}
          onClose={() => {
            setIsFormOpen(false);
            setEditingCoupon(null);
          }}
          onSubmitDone={handleFormDone}
        />
      )}

      {deleteTarget && (
        <DeleteCouponModal
          coupon={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget)}
        />
      )}
    </div>
  );
}
