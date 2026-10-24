"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useAuth } from "@/context/AuthContext";
import {
  MAX_PLAN_PRICE_CENTS,
  MIN_PLAN_PRICE_CENTS,
  DEFAULT_PLAN_PRICE_CENTS,
  formatBRL,
  isValidPlanPriceCents,
  parseBRLToCents,
} from "@/lib/subscriptions";

/** Resposta de `GET/POST /api/admin/settings`. */
interface SettingsResponse {
  priceCents: number;
  priceLabel: string;
  priceInput: string;
  source: "database" | "default";
  schemaPending: boolean;
  message?: string;
}

/**
 * Configurações globais da plataforma (`/painel/admin/configuracoes`).
 *
 * Exclusiva do Super Admin (o `PainelGuard` bloqueia /painel/admin/* e as rotas
 * de API repetem a checagem). Hoje edita o preço mensal do Plano Profissional,
 * salvo em `system_settings` com a chave `monthly_plan_price`. O valor passa a
 * valer para as próximas assinaturas criadas no checkout.
 */
export default function AdminConfiguracoesPage() {
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  const [current, setCurrent] = useState<SettingsResponse | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Carrega o preço vigente ao abrir a tela.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(
            data.error || "Não foi possível carregar as configurações."
          );
        }

        if (!active) return;
        const settings = data as SettingsResponse;
        setCurrent(settings);
        setPriceInput(settings.priceInput);
        setLoadError(null);
      } catch (error) {
        if (!active) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Não foi possível carregar as configurações."
        );
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const priceCents = parseBRLToCents(priceInput);

      if (priceCents === null || !isValidPlanPriceCents(priceCents)) {
        setNotice(null);
        setActionError(
          `Informe um preço entre ${formatBRL(
            MIN_PLAN_PRICE_CENTS
          )} e ${formatBRL(MAX_PLAN_PRICE_CENTS)}.`
        );
        return;
      }

      setIsSaving(true);
      setActionError(null);
      setNotice(null);

      try {
        const res = await fetch("/api/admin/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ monthly_plan_price: priceInput }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || "Não foi possível salvar o preço.");
        }

        const settings = data as SettingsResponse;
        setCurrent(settings);
        setPriceInput(settings.priceInput);
        setNotice(settings.message ?? "Preço do plano atualizado com sucesso.");
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "Não foi possível salvar o preço."
        );
      } finally {
        setIsSaving(false);
      }
    },
    [priceInput]
  );

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AdminHeader establishmentId={null} isSuperAdmin={isSuperAdmin} />

      <main className="px-4 py-8 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-4xl">
          <header className="mb-8">
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
                href="/painel/admin/assinantes"
                className="text-yellow-300 transition hover:text-yellow-200"
              >
                Assinantes
              </Link>
            </nav>

            <h1 className="text-3xl font-bold tracking-tight text-white">
              Configurações da Plataforma
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Parâmetros globais do SaaS. As alterações valem para todas as
              lojas e são aplicadas imediatamente no checkout.
            </p>
          </header>

          {loadError && (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
            >
              {loadError}
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-5">
            {/* Formulário do preço ------------------------------------- */}
            <section className="rounded-2xl border border-gray-800 bg-gray-900/50 p-5 sm:p-6 lg:col-span-3">
              <h2 className="text-lg font-bold text-white">Plano Mensal</h2>
              <p className="mt-1 text-sm text-gray-400">
                Preço cobrado na contratação do Plano Profissional.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label
                    htmlFor="plan-price"
                    className="mb-1.5 block text-sm font-semibold text-gray-200"
                  >
                    Preço do Plano Mensal (R$)
                  </label>
                  <div className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/60 px-3 focus-within:border-yellow-400/60">
                    <span className="text-sm font-semibold text-gray-500">
                      R$
                    </span>
                    <input
                      id="plan-price"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={priceInput}
                      onChange={(event) => setPriceInput(event.target.value)}
                      disabled={isLoading || isSaving}
                      placeholder="97,00"
                      className="w-full bg-transparent py-2.5 text-lg font-bold text-white outline-none placeholder:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-gray-500">
                    Use vírgula para os centavos (ex.: 97,00). Mínimo{" "}
                    {formatBRL(MIN_PLAN_PRICE_CENTS)} e máximo{" "}
                    {formatBRL(MAX_PLAN_PRICE_CENTS)}.
                  </p>
                </div>

                {actionError && (
                  <p
                    role="alert"
                    className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-200"
                  >
                    {actionError}
                  </p>
                )}

                {notice && (
                  <p
                    role="status"
                    className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-200"
                  >
                    {notice}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={isLoading || isSaving}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                >
                  {isSaving ? "Salvando..." : "Salvar preço do plano"}
                </button>
              </form>
            </section>

            {/* Resumo do valor vigente -------------------------------- */}
            <aside className="flex flex-col gap-4 lg:col-span-2">
              <section className="rounded-2xl border border-yellow-400/30 bg-gradient-to-b from-gray-900 to-gray-950 p-5 sm:p-6">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Preço vigente
                </p>
                <p className="mt-1 text-3xl font-extrabold text-white">
                  {current
                    ? current.priceLabel
                    : formatBRL(DEFAULT_PLAN_PRICE_CENTS)}
                  <span className="ml-1 text-sm font-semibold text-gray-500">
                    /mês
                  </span>
                </p>
                <p className="mt-3 inline-flex items-center rounded-full border border-gray-700 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-gray-300">
                  {current?.source === "database"
                    ? "Salvo no banco"
                    : "Valor padrão (fallback)"}
                </p>
                <p className="mt-3 text-xs leading-relaxed text-gray-500">
                  O checkout e a tela de assinatura leem este valor em tempo de
                  execução. Assinaturas já criadas no Asaas mantêm o preço
                  contratado.
                </p>
              </section>

              {current?.schemaPending && (
                <p className="rounded-2xl border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-xs leading-relaxed text-yellow-200">
                  A tabela <code className="font-mono">system_settings</code>{" "}
                  ainda não existe no banco. Execute a migração{" "}
                  <code className="font-mono">
                    20261110000013_create_system_settings.sql
                  </code>{" "}
                  no SQL Editor do Supabase para salvar o preço.
                </p>
              )}
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
