import { NextResponse } from "next/server";
import {
  getAsaasSubscription,
  listSubscriptionPayments,
  type AsaasPayment,
  type AsaasSubscription,
} from "@/lib/asaas";
import {
  isPaidPaymentStatus,
  type BillingStatusPayment,
  type BillingStatusResponse,
  type BillingStatusSubscription,
} from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  asaasCycleToBillingCycleId,
  getBillingCycle,
  isBillingCycleId,
  isSubscriptionActive,
  resolveRenewalDate,
  type BillingCycleId,
  type SubscriptionStatus,
} from "@/lib/subscriptions";

/**
 * GET /api/billing/status?establishment_id=... — situação da assinatura.
 *
 * Usada pelo polling do modal de checkout (Pix/boleto) e pelo botão
 * "Verificar pagamento" da tela de assinatura. Consulta as cobranças no Asaas e
 * persiste a transição para `active` assim que o pagamento é confirmado, de
 * modo que o paywall do painel libere o acesso sem depender de webhook.
 *
 * Respostas:
 *  - 200 com `BillingStatusResponse` (inclusive quando o gateway está fora:
 *    devolve o estado do banco e segue o polling);
 *  - 401/403/404/500 com `{ error }`.
 */

/** Colunas de assinatura (migração 20261110000012). */
const BASE_COLUMNS =
  "id, subscription_status, trial_ends_at, plan_id, subscription_id";

/** Colunas de ciclo/vencimento da assinatura (migração 20261110000019). */
const CYCLE_COLUMNS = `${BASE_COLUMNS}, subscription_cycle, subscription_expires_at`;

/** Linha lida de `establishments`. */
interface BillingStatusRow {
  id: string;
  subscription_status: SubscriptionStatus | null;
  trial_ends_at: string | null;
  plan_id: string | null;
  subscription_id: string | null;
  /** Ausentes enquanto a migração 20261110000019 não rodar. */
  subscription_cycle?: string | null;
  subscription_expires_at?: string | null;
}

/** Extrai a parte `YYYY-MM-DD` de uma data/coluna `date`. */
function toDateOnly(value: string | null | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec((value ?? "").trim());
  return match ? match[1] : null;
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Cobrança mais recente (maior vencimento). */
function pickLatestPayment(payments: AsaasPayment[]): AsaasPayment | null {
  if (payments.length === 0) return null;

  return [...payments].sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0];
}

/** Converte a cobrança do Asaas no resumo exposto ao painel. */
function toStatusPayment(
  payment: AsaasPayment | null
): BillingStatusPayment | null {
  if (!payment) return null;

  return {
    id: payment.id,
    status: payment.status,
    billingType: payment.billingType ?? null,
    value: payment.value,
    dueDate: payment.dueDate ?? null,
    invoiceUrl: payment.invoiceUrl ?? null,
    bankSlipUrl: payment.bankSlipUrl ?? null,
    paidAt:
      payment.confirmedDate ??
      payment.clientPaymentDate ??
      payment.paymentDate ??
      null,
  };
}

export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    searchParams.get("establishment_id")
  );
  if ("response" in resolved) return resolved.response;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return fail("Você não pode consultar a assinatura desta loja.", 403);
  }

  const adminClient = createAdminClient();

  // 1) Leitura completa (status + ciclo/vencimento da assinatura).
  const full = await adminClient
    .from("establishments")
    .select(CYCLE_COLUMNS)
    .eq("id", resolved.id)
    .maybeSingle();

  let data = full.data as BillingStatusRow | null;
  let error = full.error;
  // Migração 20261110000019 pendente: segue sem as colunas de ciclo e usa o
  // gateway como fonte do ciclo/vencimento.
  let cycleColumnsPending = false;

  if (
    error &&
    /subscription_cycle|subscription_expires_at/i.test(error.message ?? "")
  ) {
    cycleColumnsPending = true;

    const base = await adminClient
      .from("establishments")
      .select(BASE_COLUMNS)
      .eq("id", resolved.id)
      .maybeSingle();

    data = base.data as BillingStatusRow | null;
    error = base.error;
  }

  const checkedAt = new Date().toISOString();

  if (error) {
    const missingColumns =
      /subscription_status|trial_ends_at|plan_id|subscription_id/i.test(
        error.message ?? ""
      );

    // Sem as colunas não há status confiável: libera o painel (comportamento
    // da Etapa 2) e sinaliza a pendência de migração.
    if (missingColumns) {
      const pending: BillingStatusResponse = {
        subscriptionStatus: "trialing",
        isActive: true,
        planId: null,
        trialEndsAt: null,
        subscription: null,
        payment: null,
        schemaPending: true,
        checkedAt,
      };

      return NextResponse.json(pending);
    }

    console.error("[billing/status] falha ao ler o estabelecimento", error);
    return fail("Não foi possível consultar a assinatura.", 500);
  }

  const row = data;
  if (!row) return fail("Estabelecimento não encontrado.", 404);

  const currentStatus: SubscriptionStatus = row.subscription_status ?? "trialing";

  // Gateway fora do ar não invalida a assinatura: devolve o estado do banco e
  // deixa o modal tentar de novo no próximo ciclo do polling.
  //
  // A assinatura é consultada em paralelo às cobranças para trazer o ciclo
  // contratado e a próxima renovação (fonte da verdade do `nextDueDate`).
  let latest: AsaasPayment | null = null;
  let gatewaySubscription: AsaasSubscription | null = null;

  if (row.subscription_id) {
    const [paymentsResult, subscriptionResult] = await Promise.allSettled([
      listSubscriptionPayments(row.subscription_id),
      getAsaasSubscription(row.subscription_id),
    ]);

    if (paymentsResult.status === "fulfilled") {
      latest = pickLatestPayment(paymentsResult.value);
    } else {
      console.error(
        "[billing/status] falha ao consultar as cobranças no Asaas",
        paymentsResult.reason
      );
    }

    if (subscriptionResult.status === "fulfilled") {
      gatewaySubscription = subscriptionResult.value;
    } else {
      console.error(
        "[billing/status] falha ao consultar a assinatura no Asaas",
        subscriptionResult.reason
      );
    }
  }

  // Ciclo contratado: o gateway manda; a coluna `subscription_cycle` cobre
  // indisponibilidade do Asaas e bases com a migração 20261110000019 pendente.
  const rawCycle = row.subscription_cycle;
  const storedCycle: BillingCycleId | null = isBillingCycleId(rawCycle)
    ? rawCycle
    : null;
  const subscriptionCycle =
    asaasCycleToBillingCycleId(gatewaySubscription?.cycle) ?? storedCycle;

  // Próxima renovação: calculada a partir do vencimento do gateway (ou da data
  // persistida quando o Asaas está indisponível).
  const storedExpiresAt = toDateOnly(row.subscription_expires_at);
  const nextDueDate =
    resolveRenewalDate(
      gatewaySubscription?.nextDueDate,
      getBillingCycle(subscriptionCycle).months
    ) ?? storedExpiresAt;

  // Reconcilia o banco com o gateway (ciclo/renovação) sem depender de webhook,
  // para que o card continue correto no próximo carregamento mesmo offline.
  if (
    row.subscription_id &&
    gatewaySubscription &&
    !cycleColumnsPending &&
    (subscriptionCycle !== storedCycle || nextDueDate !== storedExpiresAt)
  ) {
    const sync: Record<string, string> = {};
    if (subscriptionCycle) sync.subscription_cycle = subscriptionCycle;
    if (nextDueDate) sync.subscription_expires_at = nextDueDate;

    if (Object.keys(sync).length > 0) {
      const { error: syncError } = await adminClient
        .from("establishments")
        .update(sync)
        .eq("id", row.id);

      if (syncError) {
        console.error(
          "[billing/status] falha ao sincronizar ciclo/vencimento da assinatura",
          syncError
        );
      }
    }
  }

  const subscriptionInfo: BillingStatusSubscription | null = row.subscription_id
    ? {
        id: row.subscription_id,
        cycle: subscriptionCycle,
        nextDueDate,
        value:
          typeof gatewaySubscription?.value === "number"
            ? gatewaySubscription.value
            : null,
        status: gatewaySubscription?.status ?? null,
      }
    : null;

  // Pagamento confirmado libera o acesso na hora; a assinatura só volta para
  // `past_due` quando a fatura em aberto já está vencida (`OVERDUE`).
  let nextStatus: SubscriptionStatus = currentStatus;
  if (latest) {
    if (isPaidPaymentStatus(latest.status)) {
      nextStatus = "active";
    } else if (currentStatus === "active" && latest.status === "OVERDUE") {
      nextStatus = "past_due";
    }
  }

  if (nextStatus !== currentStatus) {
    const { error: updateError } = await adminClient
      .from("establishments")
      .update({ subscription_status: nextStatus })
      .eq("id", row.id);

    if (updateError) {
      // A resposta abaixo já reflete a transição; o próximo polling tenta de
      // novo persistir (a cobrança continua paga no Asaas).
      console.error(
        "[billing/status] falha ao atualizar o status da assinatura",
        updateError
      );
    }
  }

  const response: BillingStatusResponse = {
    subscriptionStatus: nextStatus,
    isActive: isSubscriptionActive({
      subscription_status: nextStatus,
      trial_ends_at: row.trial_ends_at,
    }),
    planId: row.plan_id,
    trialEndsAt: row.trial_ends_at,
    subscription: subscriptionInfo,
    payment: toStatusPayment(latest),
    schemaPending: false,
    checkedAt,
  };

  return NextResponse.json(response);
}

