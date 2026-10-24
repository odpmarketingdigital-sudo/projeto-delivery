import { NextResponse } from "next/server";
import {
  listSubscriptionPayments,
  type AsaasPayment,
} from "@/lib/asaas";
import {
  isPaidPaymentStatus,
  type BillingStatusPayment,
  type BillingStatusResponse,
} from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  isSubscriptionActive,
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

/** Colunas necessárias (as de assinatura vêm da migração 20261110000012). */
const ESTABLISHMENT_COLUMNS =
  "id, subscription_status, trial_ends_at, plan_id, subscription_id";

/** Linha lida de `establishments`. */
interface BillingStatusRow {
  id: string;
  subscription_status: SubscriptionStatus | null;
  trial_ends_at: string | null;
  plan_id: string | null;
  subscription_id: string | null;
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

  const { data, error } = await adminClient
    .from("establishments")
    .select(ESTABLISHMENT_COLUMNS)
    .eq("id", resolved.id)
    .maybeSingle();

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
        payment: null,
        schemaPending: true,
        checkedAt,
      };

      return NextResponse.json(pending);
    }

    console.error("[billing/status] falha ao ler o estabelecimento", error);
    return fail("Não foi possível consultar a assinatura.", 500);
  }

  const row = data as BillingStatusRow | null;
  if (!row) return fail("Estabelecimento não encontrado.", 404);

  const currentStatus: SubscriptionStatus = row.subscription_status ?? "trialing";

  // Gateway fora do ar não invalida a assinatura: devolve o estado do banco e
  // deixa o modal tentar de novo no próximo ciclo do polling.
  let latest: AsaasPayment | null = null;
  if (row.subscription_id) {
    try {
      latest = pickLatestPayment(
        await listSubscriptionPayments(row.subscription_id)
      );
    } catch (gatewayError) {
      console.error(
        "[billing/status] falha ao consultar as cobranças no Asaas",
        gatewayError
      );
    }
  }

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
    payment: toStatusPayment(latest),
    schemaPending: false,
    checkedAt,
  };

  return NextResponse.json(response);
}

