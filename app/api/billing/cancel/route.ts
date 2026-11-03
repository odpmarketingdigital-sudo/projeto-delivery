import { NextResponse } from "next/server";
import { AsaasError, deleteAsaasSubscription } from "@/lib/asaas";
import type { CancelSubscriptionResponse } from "@/lib/billing";
import { revalidatePublicStore } from "@/lib/storeAvailability";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import type { SubscriptionStatus } from "@/lib/subscriptions";

/**
 * POST /api/billing/cancel — cancelamento da assinatura pelo próprio lojista.
 *
 * Body: `{ establishment_id? }` (obrigatório só para o Super Admin; o admin
 * sempre opera a própria loja — ver `resolveMenuEstablishment`).
 *
 * Fluxo (a ordem importa):
 *  1. Sessão + permissão sobre a loja (`requireMenuAccess` /
 *     `canManageEstablishment`).
 *  2. Lê a loja e, quando existe `subscription_id`, cancela PRIMEIRO no Asaas
 *     (`DELETE /subscriptions/{id}`). Se o gateway recusar ou não responder, a
 *     rota devolve erro e o banco fica INTACTO — a assinatura continua válida e
 *     o usuário pode tentar de novo.
 *  3. Só depois do "ok" do gateway atualiza o Supabase:
 *     `subscription_status = 'canceled'`, `canceled_at = now()` e
 *     `status = 'inativo'` (tira o cardápio público do ar).
 *  4. Devolve `CancelSubscriptionResponse` para o toast da tela de assinatura.
 *
 * Loja em trial ou ativada manualmente pelo Super Admin não tem assinatura no
 * Asaas: o cancelamento é apenas local (`gatewayCanceled: false`).
 *
 * Docs: https://docs.asaas.com/reference/remover-assinatura
 */

/** Colunas necessárias (as de assinatura vêm da migração 20261110000012). */
const ESTABLISHMENT_COLUMNS =
  "id, name, slug, status, subscription_status, subscription_id, plan_id";

/** Loja mínima usada pela rota. */
interface CancelEstablishmentRow {
  id: string;
  name: string | null;
  /** Slug público — usado para invalidar o cache de `/[slug]`. */
  slug: string | null;
  /** `ativo` | `inativo` — controla o cardápio público. */
  status: string | null;
  subscription_status: SubscriptionStatus | null;
  subscription_id: string | null;
  plan_id: string | null;
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Corpo JSON (ou `{}` quando ausente/inválido — só o super admin precisa dele). */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return {};
    }
    return body as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Converte um erro do Asaas na resposta HTTP da rota.
 *
 * Falhas do gateway (5xx, timeout, chave ausente) viram 502/500 e os 4xx do
 * Asaas viram 400 — em todos os casos o cancelamento NÃO é aplicado no banco.
 */
function asaasFailure(error: unknown, fallback: string) {
  if (error instanceof AsaasError) {
    const isClientError = error.status >= 400 && error.status < 500;
    const status =
      error.code === "missing_api_key" ? 500 : isClientError ? 400 : 502;

    return fail(error.message, status);
  }

  console.error("[billing/cancel]", error);
  return fail(fallback, 500);
}

export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const body = await readBody(request);
  const requestedId =
    typeof body.establishment_id === "string" ? body.establishment_id : null;

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    requestedId
  );
  if ("response" in resolved) return resolved.response;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return fail("Você não pode cancelar a assinatura desta loja.", 403);
  }

  const adminClient = createAdminClient();

  const { data, error } = await adminClient
    .from("establishments")
    .select(ESTABLISHMENT_COLUMNS)
    .eq("id", resolved.id)
    .maybeSingle();

  if (error) {
    // Sem as colunas de assinatura não há como cancelar com segurança.
    if (
      /subscription_status|subscription_id|plan_id/i.test(error.message ?? "")
    ) {
      return fail(
        "As colunas de assinatura ainda não existem no banco. Execute a migração " +
          "20261110000012_add_subscriptions_to_establishments.sql.",
        409
      );
    }

    console.error("[billing/cancel] falha ao ler o estabelecimento", error);
    return fail("Não foi possível consultar a assinatura da loja.", 500);
  }

  const row = data as CancelEstablishmentRow | null;
  if (!row) return fail("Estabelecimento não encontrado.", 404);

  const currentStatus: SubscriptionStatus =
    row.subscription_status ?? "trialing";
  const alreadyCanceled = currentStatus === "canceled";

  // Já cancelada e loja já desativada: nada a fazer (clique repetido, duas
  // abas). Responde 200 para o cliente tratar como sucesso.
  if (alreadyCanceled && row.status === "inativo") {
    const unchanged: CancelSubscriptionResponse = {
      message: "Esta assinatura já está cancelada.",
      subscriptionStatus: "canceled",
      establishmentStatus: "inativo",
      canceledAt: null,
      alreadyCanceled: true,
      gatewayCanceled: false,
    };

    return NextResponse.json(unchanged);
  }

  // 1) Gateway PRIMEIRO: se ele recusar/estiver fora, nada muda no banco.
  //
  // Assinatura já marcada como cancelada não é removida de novo no Asaas
  // (evita 404 desnecessário) — nesse caso só sincronizamos a loja.
  let gatewayCanceled = false;

  if (row.subscription_id && !alreadyCanceled) {
    try {
      await deleteAsaasSubscription(row.subscription_id);
      gatewayCanceled = true;
    } catch (error) {
      if (error instanceof AsaasError && error.status === 404) {
        // Assinatura já removida no painel do Asaas (ou por outro fluxo):
        // seguimos com a atualização local para manter o banco coerente.
        console.warn(
          `[billing/cancel] assinatura ${row.subscription_id} não existe mais no Asaas — seguindo com o cancelamento local`
        );
      } else {
        console.error(
          `[billing/cancel] falha ao cancelar a assinatura ${row.subscription_id} no Asaas`,
          error
        );

        // Banco intacto: a assinatura continua valendo e o usuário pode tentar
        // novamente. Nunca "cancelamos" só no Supabase com o gateway ativo.
        return asaasFailure(
          error,
          "Não foi possível cancelar a assinatura no Asaas. Nenhuma alteração foi feita — tente novamente em instantes."
        );
      }
    }
  }

  // 2) Banco: status da assinatura + loja desativada (cardápio público fora do ar).
  const canceledAt = new Date().toISOString();

  const fullUpdate = await adminClient
    .from("establishments")
    .update({
      subscription_status: "canceled",
      status: "inativo",
      canceled_at: canceledAt,
    })
    .eq("id", row.id);

  let updateError = fullUpdate.error;
  // `canceled_at` vem da migração 20261110000022: sem ela, salva o essencial.
  let storedCanceledAt: string | null = canceledAt;

  if (updateError && /canceled_at/i.test(updateError.message ?? "")) {
    console.warn(
      "[billing/cancel] migração 20261110000022 pendente — canceled_at não gravado"
    );

    const fallback = await adminClient
      .from("establishments")
      .update({ subscription_status: "canceled", status: "inativo" })
      .eq("id", row.id);

    updateError = fallback.error;
    if (!updateError) storedCanceledAt = null;
  }

  if (updateError) {
    console.error("[billing/cancel] falha ao atualizar a loja", updateError);

    // O Asaas já não cobra mais: a mensagem precisa dizer isso para o usuário
    // não tentar cancelar duas vezes (e o código ajuda o suporte a reconciliar).
    const message =
      gatewayCanceled && row.subscription_id
        ? "A assinatura foi cancelada no Asaas, mas não conseguimos registrar o " +
          `cancelamento na sua loja. Fale com o suporte informando o código ${row.subscription_id}.`
        : "Não foi possível registrar o cancelamento da assinatura. Tente novamente em instantes.";

    return fail(message, 500);
  }

  const message = alreadyCanceled
    ? "A assinatura já estava cancelada. A loja foi desativada e o cardápio público saiu do ar."
    : gatewayCanceled
      ? "Assinatura cancelada no Asaas. Nenhuma nova cobrança será gerada e a loja foi desativada."
      : "Assinatura cancelada. Nenhuma nova cobrança será gerada e a loja foi desativada.";

  const response: CancelSubscriptionResponse = {
    message,
    subscriptionStatus: "canceled",
    establishmentStatus: "inativo",
    canceledAt: storedCanceledAt,
    alreadyCanceled,
    gatewayCanceled,
  };

  // O cardápio público acabou de sair do ar: descarta o cache da vitrine para
  // que o link `/[slug]` já responda com a página de loja indisponível.
  revalidatePublicStore(row.slug);

  return NextResponse.json(response);
}
