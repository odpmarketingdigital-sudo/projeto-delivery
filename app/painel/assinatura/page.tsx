"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useSubscription } from "@/app/painel/components/SubscriptionProvider";
import type { BillingStatusResponse } from "@/lib/billing";
import {
  IPEPPER_PRO_PLAN,
  SUBSCRIPTION_CYCLE_LABELS,
  buildBillingCyclePrices,
  formatDateBR,
  getSubscriptionStatusLabel,
  type BillingCycleId,
} from "@/lib/subscriptions";
import { CheckoutModal } from "./CheckoutModal";

/** Converte um ISO em `dd/mm/aaaa` (null quando ausente/inválido). */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString("pt-BR");
}

/** Cores/ações do card de status conforme a situação da conta. */
type StatusTone = "success" | "warning" | "danger";

const TONE_STYLES: Record<StatusTone, { badge: string; title: string }> = {
  success: {
    badge: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
    title: "text-emerald-300",
  },
  warning: {
    badge: "border-yellow-400/40 bg-yellow-400/10 text-yellow-300",
    title: "text-yellow-300",
  },
  danger: {
    badge: "border-red-500/40 bg-red-500/10 text-red-300",
    title: "text-red-300",
  },
};

/** Linha de detalhe (rótulo + valor) do card de status. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-gray-200">
        {value}
      </dd>
    </div>
  );
}

/**
 * Tela de planos e assinatura do painel (`/painel/assinatura`).
 *
 * É a única rota de cobrança: também é o destino do bloqueio aplicado pelo
 * guard quando o trial expira (junto de `/painel/configuracoes`). Mostra a
 * situação real da loja (lida pelo `SubscriptionProvider`) e o card do Plano
 * Profissional.
 *
 * O botão "Assinar Agora" abre o `CheckoutModal`, que contrata o plano via
 * `POST /api/billing/checkout` (Pix, cartão ou boleto no Asaas) e acompanha a
 * confirmação do pagamento por `GET /api/billing/status`. Ao confirmar, a
 * assinatura é relida com `refresh()`.
 */
export default function AssinaturaPage() {
  const {
    establishmentId,
    establishmentName,
    status,
    daysRemaining,
    trialEndsAt,
    planId,
    cycle,
    expiresAt,
    isActive,
    isLoading,
    error,
    isSchemaPending,
    isSuperAdmin,
    refresh,
  } = useSubscription();

  const [notice, setNotice] = useState<string | null>(null);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);

  // Ciclo e próxima renovação informados pelo gateway. O `SubscriptionProvider`
  // já lê as colunas persistidas em `establishments`; esta consulta garante o
  // dado atualizado do Asaas (inclusive para assinaturas antigas, sem as
  // colunas de ciclo).
  const [remoteCycle, setRemoteCycle] = useState<BillingCycleId | null>(null);
  const [remoteRenewal, setRemoteRenewal] = useState<string | null>(null);
  // `true` quando a loja tem assinatura no gateway (Asaas). Sem ela (ativação
  // manual do Super Admin) a data de vencimento é o `trial_ends_at` estendido.
  const [hasGatewaySubscription, setHasGatewaySubscription] = useState(false);
  // `true` depois da primeira consulta ao status (evita exibir data provisória).
  const [detailsLoaded, setDetailsLoaded] = useState(false);

  // Preço mensal vigente do plano (system_settings). O fallback local
  // (`IPEPPER_PRO_PLAN`) é usado até a resposta da API — se a rota falhar, ele
  // permanece e os ciclos semestral/anual continuam calculados.
  const [planPriceCents, setPlanPriceCents] = useState<number>(
    IPEPPER_PRO_PLAN.priceCents
  );
  // Ciclo escolhido para a cobrança (mensal por padrão).
  const [cycleId, setCycleId] = useState<BillingCycleId>("monthly");

  useEffect(() => {
    let active = true;

    fetch("/api/billing/plan", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { priceCents?: unknown } | null) => {
        if (!active || !data) return;
        if (
          typeof data.priceCents === "number" &&
          Number.isFinite(data.priceCents) &&
          data.priceCents > 0
        ) {
          setPlanPriceCents(Math.round(data.priceCents));
        }
      })
      .catch(() => {
        // Mantém o fallback: a tela continua funcional sem a configuração.
      });

    return () => {
      active = false;
    };
  }, []);

  // Mensal, semestral (−5%) e anual (−10%) com os valores já calculados.
  const cyclePrices = buildBillingCyclePrices(planPriceCents);
  const selectedCycle =
    cyclePrices.find((cycle) => cycle.id === cycleId) ?? cyclePrices[0];

  /**
   * Consulta `GET /api/billing/status` para ler ciclo e próxima renovação
   * direto do gateway. Falha aqui não quebra a tela: o card segue com os dados
   * persistidos no banco (lidos pelo `SubscriptionProvider`).
   */
  const loadSubscriptionDetails = useCallback(async () => {
    if (!establishmentId) return;

    try {
      const response = await fetch(
        `/api/billing/status?establishment_id=${encodeURIComponent(establishmentId)}`,
        { cache: "no-store" }
      );

      if (!response.ok) return;

      const data = (await response.json()) as BillingStatusResponse;

      setHasGatewaySubscription(Boolean(data.subscription));
      setDetailsLoaded(true);
      if (!data.subscription) return;

      setRemoteCycle(data.subscription.cycle);
      setRemoteRenewal(data.subscription.nextDueDate);
    } catch {
      // Sem o gateway o card usa ciclo/vencimento lidos do banco.
    }
  }, [establishmentId]);

  // Primeira leitura agendada para não disparar `setState` síncrono no efeito.
  useEffect(() => {
    if (isLoading || !establishmentId) return;

    const timer = window.setTimeout(() => {
      void loadSubscriptionDetails();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [isLoading, establishmentId, loadSubscriptionDetails]);

  // Callbacks estáveis: o modal os usa em efeitos (ESC, polling do pagamento).
  const closeCheckout = useCallback(() => setIsCheckoutOpen(false), []);
  const handleCheckoutConfirmed = useCallback(() => {
    void refresh();
    // Relê o ciclo/renovação: a assinatura recém-contratada pode trazer um
    // ciclo diferente do que estava persistido.
    void loadSubscriptionDetails();
  }, [refresh, loadSubscriptionDetails]);

  const isTrialExpired = status === "trialing" && !isActive;

  // Ciclo contratado: gateway → banco → desconhecido.
  const activeCycle = remoteCycle ?? cycle;
  // Próxima renovação: gateway → coluna `subscription_expires_at` → data paga
  // estendida pelo Super Admin na ativação manual (loja sem assinatura no Asaas).
  const renewalDate =
    remoteRenewal ??
    expiresAt ??
    (detailsLoaded && !hasGatewaySubscription && status !== "trialing"
      ? trialEndsAt
      : null);

  const statusLabel = isTrialExpired
    ? "Período de Testes Expirado"
    : getSubscriptionStatusLabel(status, activeCycle);

  const planLabel = (() => {
    if (status === "active") {
      return activeCycle
        ? `${IPEPPER_PRO_PLAN.name} (${SUBSCRIPTION_CYCLE_LABELS[activeCycle]})`
        : IPEPPER_PRO_PLAN.name;
    }
    if (planId) return planId;
    return status === "trialing"
      ? "Teste grátis (sem plano)"
      : "Nenhum plano ativo";
  })();

  const renewalLabel = formatDateBR(renewalDate);

  const tone: StatusTone = isActive
    ? status === "active"
      ? "success"
      : "warning"
    : "danger";

  const description = (() => {
    if (status === "active") {
      return "Sua assinatura está em dia. Todos os recursos do painel estão liberados.";
    }
    if (status === "trialing" && isActive) {
      return `Você ainda tem ${daysRemaining} ${
        daysRemaining === 1 ? "dia" : "dias"
      } de teste grátis. Ative o plano quando quiser para não interromper a operação.`;
    }
    if (status === "trialing") {
      return "O período de testes terminou. Ative o Plano Profissional para voltar a acessar pedidos, produtos, clientes e dashboard.";
    }
    if (status === "past_due") {
      return "O pagamento da assinatura não foi identificado. Regularize para liberar o painel novamente.";
    }
    return "A assinatura foi cancelada. Reative o Plano Profissional para voltar a usar todos os recursos.";
  })();

  const trialEndLabel = formatDate(trialEndsAt);

  const handleSubscribe = () => {
    if (status === "active") {
      setNotice(
        "Sua assinatura já está ativa — não é necessário contratar o plano novamente."
      );
      return;
    }

    if (!establishmentId) {
      setNotice(
        "Não encontramos a loja desta conta. Fale com o suporte para concluir a contratação."
      );
      return;
    }

    setNotice(null);
    setIsCheckoutOpen(true);
  };

  return (
    <>
      <AdminHeader
        establishmentId={establishmentId}
        isSuperAdmin={isSuperAdmin}
      />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">
            Assinatura
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Acompanhe o período de testes e ative o Plano Profissional para
            manter o seu delivery no ar.
          </p>
        </div>

        {isSuperAdmin && (
          <p className="rounded-xl border border-gray-700 bg-gray-900/60 px-4 py-3 text-sm text-gray-300">
            Você está logado como <strong>Super Admin</strong>. A assinatura é
            cobrada por loja — abra o painel de uma loja específica para
            gerenciar a cobrança dela.
          </p>
        )}

        {isSchemaPending && (
          <p className="rounded-xl border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-200">
            As colunas de assinatura ainda não existem no banco de dados.
            Execute a migração{" "}
            <code className="font-mono text-xs">
              20261110000012_add_subscriptions_to_establishments.sql
            </code>{" "}
            para ativar o controle de trial e cobrança.
          </p>
        )}

        {error && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => void refresh()}
              className="shrink-0 rounded-full border border-red-400/50 px-3 py-1 text-xs font-bold text-red-100 transition hover:bg-red-500/20"
            >
              Tentar novamente
            </button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-5">
          {/* Situação atual da conta ------------------------------------- */}
          <section className="flex flex-col gap-3 rounded-2xl border border-gray-800 bg-gray-900/60 p-5 lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Situação da conta
              </h2>
              <span
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${TONE_STYLES[tone].badge}`}
              >
                {statusLabel}
              </span>
            </div>

            {isLoading ? (
              <p className="text-sm text-gray-400">
                Carregando dados da assinatura...
              </p>
            ) : (
              <>
                <p className={`text-lg font-bold ${TONE_STYLES[tone].title}`}>
                  {statusLabel}
                </p>
                <p className="text-sm text-gray-400">{description}</p>

                <dl className="mt-1 space-y-2 text-sm">
                  <DetailRow
                    label="Estabelecimento"
                    value={establishmentName ?? "—"}
                  />
                  {status === "trialing" && (
                    <DetailRow
                      label="Teste termina em"
                      value={trialEndLabel ?? "—"}
                    />
                  )}
                  {status === "trialing" && (
                    <DetailRow
                      label="Dias restantes"
                      value={`${daysRemaining} ${
                        daysRemaining === 1 ? "dia" : "dias"
                      }`}
                    />
                  )}
                  <DetailRow label="Plano" value={planLabel} />
                  {(status === "active" || status === "past_due") && (
                    <DetailRow
                      label={
                        status === "active" ? "Próxima renovação" : "Vencimento"
                      }
                      value={renewalLabel ?? "—"}
                    />
                  )}
                </dl>

                {!isActive && (
                  <p className="mt-auto rounded-xl border border-yellow-400/25 bg-yellow-400/10 px-3 py-2 text-xs font-medium text-yellow-200">
                    Pedidos, produtos, clientes e dashboard ficam bloqueados até
                    a ativação. Apenas a tela de Configurações continua
                    liberada.
                  </p>
                )}
              </>
            )}
          </section>

          {/* Card do plano ---------------------------------------------- */}
          <section className="relative flex flex-col gap-5 rounded-2xl border border-yellow-400/30 bg-gradient-to-b from-gray-900 via-gray-900 to-gray-950 p-5 sm:p-6 lg:col-span-3">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <span className="inline-flex items-center rounded-full bg-yellow-400 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wide text-gray-950">
                  Plano único
                </span>
                <h2 className="mt-2 text-xl font-bold text-white sm:text-2xl">
                  {IPEPPER_PRO_PLAN.name}
                </h2>
                <p className="mt-1 max-w-md text-sm text-gray-400">
                  {IPEPPER_PRO_PLAN.tagline}
                </p>
              </div>
              <div className="shrink-0 text-left sm:text-right">
                <p className="text-3xl font-extrabold text-white sm:text-4xl">
                  {selectedCycle.totalLabel}
                </p>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  por {selectedCycle.durationLabel}
                  {selectedCycle.discountPercent > 0 && (
                    <span className="ml-2 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                      −{selectedCycle.discountPercent}%
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Forma de cobrança
              </h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {cyclePrices.map((cycle) => {
                  const selected = cycle.id === selectedCycle.id;

                  return (
                    <button
                      key={cycle.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setCycleId(cycle.id)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition ${
                        selected
                          ? "border-yellow-400/70 bg-yellow-400/10"
                          : "border-gray-700 bg-gray-950/40 hover:border-gray-600"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-gray-100">
                          {cycle.label}
                        </span>
                        {cycle.discountPercent > 0 && (
                          <span className="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
                            −{cycle.discountPercent}%
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-sm font-bold tabular-nums text-white">
                        {cycle.totalLabel}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-gray-500">
                        {cycle.months === 1
                          ? "cobrança a cada mês"
                          : `equivale a ${cycle.monthlyEquivalentLabel}/mês`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Recursos incluídos
              </h3>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {IPEPPER_PRO_PLAN.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2 text-sm text-gray-300"
                  >
                    <svg
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0 text-yellow-400"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                    >
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Formas de pagamento aceitas
              </h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {IPEPPER_PRO_PLAN.paymentMethods.map((method) => (
                  <li
                    key={method.label}
                    className="rounded-full border border-gray-700 bg-gray-950/60 px-3 py-1.5 text-xs font-semibold text-gray-200"
                  >
                    {method.label}
                    {method.note && (
                      <span className="ml-1 font-medium text-gray-500">
                        · {method.note}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-auto flex flex-col gap-2">
              <button
                type="button"
                onClick={handleSubscribe}
                disabled={status === "active" || isLoading}
                className="w-full rounded-xl bg-yellow-400 px-4 py-3 text-base font-extrabold text-gray-950 transition hover:bg-yellow-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-200 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === "active" ? "Plano ativo" : "Assinar Agora"}
              </button>
              <p className="text-center text-xs text-gray-500">
                {selectedCycle.label} · {selectedCycle.totalLabel} por{" "}
                {selectedCycle.periodLabel} · pagamento seguro, com acesso
                liberado após a confirmação.
              </p>
            </div>

            {notice && (
              <p
                role="status"
                className="rounded-xl border border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-sm font-medium text-yellow-200"
              >
                {notice}
              </p>
            )}
          </section>
        </div>
      </main>

      {isCheckoutOpen && (
        <CheckoutModal
          establishmentId={establishmentId}
          cyclePrice={selectedCycle}
          planName={IPEPPER_PRO_PLAN.name}
          onClose={closeCheckout}
          onConfirmed={handleCheckoutConfirmed}
        />
      )}
    </>
  );
}
