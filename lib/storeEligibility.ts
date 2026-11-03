/**
 * Elegibilidade da loja para ficar online (vitrine + painel).
 *
 * Módulo **isomórfico** (sem APIs de servidor/navegador): a mesma regra é usada
 * pelo servidor (`lib/storeAvailability.ts`, `/[slug]`, webhook do Asaas) e
 * pelo painel do lojista (`SubscriptionProvider` + banner de inadimplência).
 *
 * Regra (nesta ordem):
 *  1. `establishments.status` precisa ser `ativo` (liga/desliga do Super Admin);
 *  2. `subscription_status = 'canceled'` derruba a loja mesmo com `status`
 *     ativo (o webhook do Asaas encerra a assinatura sem mexer no status);
 *  3. atraso **maior que** `OVERDUE_GRACE_DAYS` (15 dias) também derruba: a
 *     tolerância começa a contar do vencimento da fatura em aberto — ou do fim
 *     do período pago/trial, quando ele for posterior — para nunca suspender
 *     quem ainda está com o mês pago.
 *
 * `trialing`, `active` e `past_due` **dentro** da tolerância seguem no ar: o
 * inadimplente continua vendendo durante a carência.
 */

import { todayDateOnly } from "./subscriptions";

/** Dias de carência após o vencimento antes de suspender a loja. */
export const OVERDUE_GRACE_DAYS = 15;

/** Milissegundos de um dia — base do cálculo de dias em atraso. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Campos de `establishments` usados na decisão.
 * Todos opcionais: bases legadas (sem as migrações de assinatura) continuam
 * funcionando com o que existir.
 */
export interface StoreEligibilityInput {
  /** `ativo` | `inativo` (coluna `status`). */
  status?: string | null;
  /** `trialing` | `active` | `past_due` | `canceled`. */
  subscription_status?: string | null;
  /**
   * Vencimento da cobrança em aberto (`payment_due_date`, migração
   * 20261110000023). Gravado pelo webhook em `PAYMENT_OVERDUE` e limpo no
   * pagamento.
   */
  payment_due_date?: string | null;
  /** Fim do período pago / data de renovação (`subscription_expires_at`). */
  subscription_expires_at?: string | null;
  /**
   * Fim do período pago/trial (`trial_ends_at`). O webhook reaproveita a coluna
   * como "acesso pago até".
   */
  trial_ends_at?: string | null;
}

/** Por que a loja está fora do ar (para log/diagnóstico, nunca para o cliente). */
export type StoreEligibilityReason = "status" | "subscription" | "overdue";

/** Resultado de `evaluateStoreEligibility`. */
export interface StoreEligibility {
  /** `true` quando a vitrine pode ser exibida. */
  isEligible: boolean;
  /** Motivo do bloqueio (`null` quando elegível). */
  reason: StoreEligibilityReason | null;
  /** Dias corridos de atraso (0 quando não há fatura vencida). */
  daysOverdue: number;
  /** Data de referência do atraso em `YYYY-MM-DD` (null quando em dia). */
  dueDate: string | null;
  /**
   * `true` quando a loja está ativa mas o atraso já passou da carência — é o
   * sinal para persistir a suspensão (`status = 'inativo'`).
   */
  requiresSuspension: boolean;
}

/** Converte `Date`/timestamp/`YYYY-MM-DD` em data `YYYY-MM-DD` (sem fuso). */
export function toDateOnly(
  value: string | Date | null | undefined
): string | null {
  if (!value) return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString().slice(0, 10) : null;
  }

  const trimmed = value.trim();
  // Datas `YYYY-MM-DD` NÃO passam por `Date` para não deslocar o dia pelo fuso.
  const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (dateOnly) return dateOnly[1];

  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : null;
}

/** `YYYY-MM-DD` → milissegundos em 00:00 UTC (null quando inválida). */
function dateOnlyToMs(value: string): number | null {
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Dias corridos de atraso entre `dueDate` e hoje (fuso de Brasília).
 *
 * Datas no futuro e valores inválidos devolvem `0` — nunca negativo.
 */
export function getDaysOverdue(
  dueDate: string | Date | null | undefined,
  now: Date = new Date()
): number {
  const due = toDateOnly(dueDate);
  if (!due) return 0;

  const dueMs = dateOnlyToMs(due);
  const todayMs = dateOnlyToMs(todayDateOnly(now));
  if (dueMs === null || todayMs === null) return 0;

  return Math.max(0, Math.round((todayMs - dueMs) / DAY_MS));
}

/** Data mais recente entre duas datas `YYYY-MM-DD` (ignora nulos). */
function laterDateOnly(
  first: string | null,
  second: string | null
): string | null {
  if (!first) return second;
  if (!second) return first;
  // Comparação lexicográfica funciona para `YYYY-MM-DD`.
  return first >= second ? first : second;
}

/**
 * Data de referência do atraso.
 *
 * - Sem fatura vencida registrada (`payment_due_date`) e com a assinatura em
 *   dia/trial → `null` (nada a cobrar);
 * - `past_due` sem data registrada (base criada antes do webhook gravar o
 *   vencimento) → usa o fim do período pago/trial;
 * - Caso contrário → o MAIOR entre o vencimento da fatura e o fim do período
 *   pago, para não cobrar carência de quem ainda tem o mês quitado.
 */
export function resolveBillingDueDate(
  store: StoreEligibilityInput
): string | null {
  const due = toDateOnly(store.payment_due_date);
  const paidUntil = laterDateOnly(
    toDateOnly(store.subscription_expires_at),
    toDateOnly(store.trial_ends_at)
  );

  const hasUnpaidInvoice = Boolean(due);
  const isPastDue = store.subscription_status === "past_due";
  if (!hasUnpaidInvoice && !isPastDue) return null;

  return laterDateOnly(due, paidUntil);
}

/**
 * Aplica a regra completa de elegibilidade.
 *
 * `requiresSuspension` só é `true` para lojas **ativas** que passaram da
 * carência — é exatamente o caso em que a suspensão deve ser persistida.
 */
export function evaluateStoreEligibility(
  store: StoreEligibilityInput | null | undefined,
  now: Date = new Date()
): StoreEligibility {
  const dueDate = store ? resolveBillingDueDate(store) : null;
  const daysOverdue = dueDate ? getDaysOverdue(dueDate, now) : 0;
  const overdueBeyondGrace = daysOverdue > OVERDUE_GRACE_DAYS;

  if (!store) {
    return {
      isEligible: false,
      reason: "status",
      daysOverdue,
      dueDate,
      requiresSuspension: false,
    };
  }

  if (store.status !== "ativo") {
    return {
      isEligible: false,
      reason: "status",
      daysOverdue,
      dueDate,
      requiresSuspension: false,
    };
  }

  if (store.subscription_status === "canceled") {
    return {
      isEligible: false,
      reason: "subscription",
      daysOverdue,
      dueDate,
      requiresSuspension: false,
    };
  }

  if (overdueBeyondGrace) {
    return {
      isEligible: false,
      reason: "overdue",
      daysOverdue,
      dueDate,
      requiresSuspension: true,
    };
  }

  return {
    isEligible: true,
    reason: null,
    daysOverdue,
    dueDate,
    requiresSuspension: false,
  };
}

/**
 * Texto curto do atraso (ex.: "há 18 dias") para banners e logs.
 * Devolve `null` quando não há atraso.
 */
export function describeOverdueDays(daysOverdue: number): string | null {
  if (!Number.isFinite(daysOverdue) || daysOverdue <= 0) return null;
  return daysOverdue === 1 ? "há 1 dia" : `há ${daysOverdue} dias`;
}
