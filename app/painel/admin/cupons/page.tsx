"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useAuth } from "@/context/AuthContext";
import {
  subscriptionCouponDiscountLabel,
  subscriptionCouponRemainingUsages,
  toSubscriptionCouponNumber,
  type SubscriptionCouponRecord,
} from "@/lib/subscription-coupons";
import { SubscriptionCouponFormModal } from "./SubscriptionCouponFormModal";

/** Resposta de `GET /api/admin/subscription-coupons`. */
interface CouponsResponse {
  coupons: SubscriptionCouponRecord[];
  schemaPending: boolean;
}

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Data curta ou "—" quando ausente/inválida. */
function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : dateFormatter.format(parsed);
}

/**
 * Gestão dos cupons de ASSINATURA (`/painel/admin/cupons`).
 *
 * Exclusiva do Super Admin (`PainelGuard` bloqueia /painel/admin/* e
 * `/api/admin/subscription-coupons` repete a checagem). Os cupons são globais e
 * incidem sobre o total do período escolhido no checkout da assinatura
 * (mensal / semestral −5% / anual −10%).
 */
export default function AdminCuponsPage() {
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  const [coupons, setCoupons] = useState<SubscriptionCouponRecord[]>([]);
  const [schemaPending, setSchemaPending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingCoupon, setEditingCoupon] =
    useState<SubscriptionCouponRecord | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const loadCoupons = useCallback(async () => {
    setIsLoading(true);

    try {
      const response = await fetch("/api/admin/subscription-coupons", {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => ({}))) as
        | CouponsResponse
        | { error?: unknown };

      if (!response.ok) {
        throw new Error(
          "error" in data && typeof data.error === "string"
            ? data.error
            : "Não foi possível carregar os cupons de assinatura."
        );
      }

      const payload = data as CouponsResponse;
      setCoupons(payload.coupons ?? []);
      setSchemaPending(Boolean(payload.schemaPending));
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar os cupons de assinatura."
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // IIFE assíncrona: mantém as atualizações de estado fora do corpo síncrono
    // do efeito (evita renders em cascata — react-hooks/set-state-in-effect).
    void (async () => {
      await loadCoupons();
    })();
  }, [loadCoupons]);

  /** Aplica a alteração de status/remoção já validada pela API. */
  const runAction = useCallback(
    async (
      id: string,
      request: () => Promise<Response>,
      successMessage: string
    ) => {
      setPendingId(id);
      setActionError(null);
      setNotice(null);

      try {
        const response = await request();
        const data = (await response.json().catch(() => ({}))) as {
          error?: unknown;
        };

        if (!response.ok) {
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : "Não foi possível concluir a ação."
          );
        }

        setNotice(successMessage);
        await loadCoupons();
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Não foi possível concluir a ação."
        );
      } finally {
        setPendingId(null);
      }
    },
    [loadCoupons]
  );

  const handleToggleActive = useCallback(
    (coupon: SubscriptionCouponRecord) => {
      void runAction(
        coupon.id,
        () =>
          fetch("/api/admin/subscription-coupons", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: coupon.id, active: !coupon.active }),
          }),
        coupon.active
          ? `Cupom ${coupon.code} desativado.`
          : `Cupom ${coupon.code} ativado.`
      );
    },
    [runAction]
  );

  const handleDelete = useCallback(
    (coupon: SubscriptionCouponRecord) => {
      const confirmed =
        typeof window === "undefined" ||
        window.confirm(
          `Excluir o cupom ${coupon.code}? Esta ação não pode ser desfeita.`
        );

      if (!confirmed) return;

      void runAction(
        coupon.id,
        () =>
          fetch(`/api/admin/subscription-coupons?id=${encodeURIComponent(coupon.id)}`, {
            method: "DELETE",
          }),
        `Cupom ${coupon.code} excluído.`
      );
    },
    [runAction]
  );

  const summary = useMemo(() => {
    const active = coupons.filter((coupon) => coupon.active).length;
    const usages = coupons.reduce(
      (total, coupon) => total + toSubscriptionCouponNumber(coupon.used_count),
      0
    );
    return { total: coupons.length, active, usages };
  }, [coupons]);

  return (
    <div className="flex flex-1 flex-col text-slate-900">
      <AdminHeader establishmentId={null} isSuperAdmin={isSuperAdmin} />

      <main className="px-4 py-8 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-5xl">
          <header className="mb-8">
            <nav className="mb-3 flex flex-wrap items-center gap-3 text-sm font-semibold">
              <Link
                href="/painel/admin"
                className="text-slate-600 transition hover:text-slate-900"
              >
                ← Estabelecimentos
              </Link>
              <span aria-hidden="true" className="text-slate-600">
                |
              </span>
              <Link
                href="/painel/admin/assinantes"
                className="text-slate-600 transition hover:text-slate-900"
              >
                Assinantes
              </Link>
              <span aria-hidden="true" className="text-slate-600">
                |
              </span>
              <Link
                href="/painel/admin/configuracoes"
                className="text-amber-600 transition hover:text-amber-700"
              >
                Preço do Plano
              </Link>
            </nav>

            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold tracking-tight text-slate-900">
                  Cupons de Assinatura
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-slate-600">
                  Cupons globais aplicados no checkout do plano, sobre o total do
                  período (mensal, semestral −5% ou anual −10%).
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setEditingCoupon(null);
                  setIsFormOpen(true);
                }}
                disabled={schemaPending}
                className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                + Novo cupom
              </button>
            </div>
          </header>

          {schemaPending && (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              A tabela <code className="font-mono">subscription_coupons</code>{" "}
              ainda não existe neste projeto. Rode a migração{" "}
              <code className="font-mono">
                20261110000018_create_subscription_coupons.sql
              </code>{" "}
              para habilitar o gerenciamento.
            </div>
          )}

          {loadError && (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {loadError}
            </div>
          )}

          {actionError && (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {actionError}
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
            >
              {notice}
            </div>
          )}

          <section className="mb-5 grid gap-3 sm:grid-cols-3">
            {[
              { label: "Cupons cadastrados", value: summary.total },
              { label: "Ativos", value: summary.active },
              { label: "Usos registrados", value: summary.usages },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {item.label}
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{item.value}</p>
              </div>
            ))}
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {isLoading ? (
              <p className="px-5 py-10 text-center text-sm text-slate-600">
                Carregando cupons...
              </p>
            ) : coupons.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <p className="text-sm font-semibold text-slate-800">
                  Nenhum cupom de assinatura cadastrado.
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Crie o primeiro cupom para oferecer descontos no checkout do
                  plano.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {coupons.map((coupon) => {
                  const remaining = subscriptionCouponRemainingUsages(coupon);
                  const isBusy = pendingId === coupon.id;

                  return (
                    <article
                      key={coupon.id}
                      className="flex flex-wrap items-center gap-4 px-5 py-4"
                    >
                      <div className="min-w-[9rem] flex-1">
                        <p className="font-mono text-sm font-bold tracking-wide text-slate-900">
                          {coupon.code}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Criado em {formatDate(coupon.created_at)}
                        </p>
                      </div>

                      <div className="min-w-[7rem]">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Desconto
                        </p>
                        <p className="text-sm font-bold text-amber-600">
                          {subscriptionCouponDiscountLabel(coupon)}
                        </p>
                      </div>

                      <div className="min-w-[7rem]">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Usos
                        </p>
                        <p className="text-sm text-slate-800">
                          {toSubscriptionCouponNumber(coupon.used_count)}
                          {coupon.usage_limit == null
                            ? " / ilimitado"
                            : ` / ${toSubscriptionCouponNumber(
                                coupon.usage_limit
                              )}`}
                          {remaining === 0 ? " (esgotado)" : ""}
                        </p>
                      </div>

                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                          coupon.active
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {coupon.active ? "Ativo" : "Inativo"}
                      </span>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleActive(coupon)}
                          disabled={isBusy}
                          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-100 disabled:opacity-50"
                        >
                          {coupon.active ? "Desativar" : "Ativar"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCoupon(coupon);
                            setIsFormOpen(true);
                          }}
                          disabled={isBusy}
                          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-100 disabled:opacity-50"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(coupon)}
                          disabled={isBusy}
                          className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                        >
                          Excluir
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </main>

      {isFormOpen && (
        <SubscriptionCouponFormModal
          editing={editingCoupon}
          onClose={() => {
            setIsFormOpen(false);
            setEditingCoupon(null);
          }}
          onSaved={() => {
            const wasEditing = Boolean(editingCoupon);
            const code = editingCoupon?.code;
            setIsFormOpen(false);
            setEditingCoupon(null);
            setActionError(null);
            setNotice(
              wasEditing
                ? `Cupom ${code} atualizado com sucesso.`
                : "Cupom de assinatura criado com sucesso."
            );
            void loadCoupons();
          }}
        />
      )}
    </div>
  );
}
