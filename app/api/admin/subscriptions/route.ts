import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";
import { createAdminClient } from "@/lib/supabase/server";
import {
  MAX_TRIAL_EXTENSION_DAYS,
  MANUAL_ACTIVATION_DAYS,
  SUBSCRIPTION_STATUSES,
  TRIAL_EXTENSION_DAYS,
  extendSubscriptionDate,
  isSubscriptionStatus,
  type SubscriptionStatus,
} from "@/lib/subscriptions";

/**
 * GET/PATCH /api/admin/subscriptions — gestão manual de assinantes.
 *
 * Exclusivo do Super Admin (`requireSuperAdmin`). Complementa o fluxo do Asaas
 * (checkout + webhook): aqui o suporte consegue liberar/bloquear uma loja que
 * pagou por Pix direto, dinheiro ou cortesia, prorrogar o trial ou corrigir
 * uma data de vencimento.
 *
 * GET  ?search=&status=&page=&pageSize=
 *      → `{ establishments, pagination, schemaPending }`
 * PATCH `{ id, action: "activate" | "extend_trial" | "cancel" | "set_status",
 *         days?, subscription_status?, trial_ends_at? }`
 *      → `{ establishment, message }`
 *
 * Escritas via service role key (bypass de RLS); as colunas de assinatura vêm
 * da migração 20261110000012.
 */

/** Colunas devolvidas na listagem (inclui os dados de cobrança). */
const SUBSCRIBER_COLUMNS =
  "id, name, owner_name, email, phone, whatsapp, status, " +
  "subscription_status, trial_ends_at, plan_id, subscription_id, " +
  "customer_payment_id, created_at";

/** Colunas mínimas quando a migração de assinaturas ainda não foi aplicada. */
const LEGACY_COLUMNS =
  "id, name, owner_name, email, phone, whatsapp, status, created_at";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/** Linha de `establishments` exposta ao painel. */
interface SubscriberRow {
  id: string;
  name: string | null;
  owner_name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp?: string | null;
  status?: string | null;
  subscription_status?: SubscriptionStatus | null;
  trial_ends_at?: string | null;
  plan_id?: string | null;
  subscription_id?: string | null;
  customer_payment_id?: string | null;
  created_at?: string | null;
}

/** Ações rápidas aceitas no PATCH. */
const ADMIN_ACTIONS = [
  "activate",
  "extend_trial",
  "cancel",
  "set_status",
] as const;

type AdminAction = (typeof ADMIN_ACTIONS)[number];

function isAdminAction(value: unknown): value is AdminAction {
  return (
    typeof value === "string" &&
    (ADMIN_ACTIONS as readonly string[]).includes(value)
  );
}

/** Corpo aceito no PATCH (todos os campos são validados individualmente). */
interface PatchBody {
  id?: unknown;
  action?: unknown;
  subscription_status?: unknown;
  trial_ends_at?: unknown;
  days?: unknown;
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Inteiro positivo com teto (usado por `page`/`pageSize`). */
function parsePositiveInt(
  value: string | null,
  fallback: number,
  max: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * Sanitiza o termo de busca antes de interpolá-lo no filtro `.or()` do
 * PostgREST (vírgula e parênteses separariam condições; `%`/`_` viram curinga).
 */
function sanitizeSearch(value: string): string {
  return value
    .replace(/[,()*"%_\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** `true` quando o erro indica que as colunas de assinatura não existem. */
function isMissingSubscriptionColumns(error: {
  message?: string | null;
} | null): boolean {
  return /subscription_status|trial_ends_at|plan_id|customer_payment_id/i.test(
    error?.message ?? ""
  );
}

/** Resposta da consulta usada internamente (tipagem mínima). */
interface PageQueryResult {
  data: SubscriberRow[] | null;
  error: { message?: string | null; code?: string | null } | null;
  count: number | null;
}

/**
 * Executa a consulta paginada de lojas.
 * `withSubscriptions = false` é o fallback para bases sem a migração 12.
 */
async function fetchPage(options: {
  withSubscriptions: boolean;
  search: string;
  status: SubscriptionStatus | null;
  page: number;
  pageSize: number;
}): Promise<PageQueryResult> {
  const adminClient = createAdminClient();
  const columns = options.withSubscriptions
    ? SUBSCRIBER_COLUMNS
    : LEGACY_COLUMNS;

  const from = (options.page - 1) * options.pageSize;
  const to = from + options.pageSize - 1;

  let query = adminClient
    .from("establishments")
    .select(columns, { count: "exact" });

  if (options.search) {
    const term = options.search;
    query = query.or(
      `name.ilike.%${term}%,owner_name.ilike.%${term}%,email.ilike.%${term}%`
    );
  }

  if (options.withSubscriptions && options.status) {
    query = query.eq("subscription_status", options.status);
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(from, to);

  return {
    data: (data as SubscriberRow[] | null) ?? null,
    error,
    count: count ?? null,
  };
}

/** GET — lista paginada de assinantes com busca e filtro de status. */
export async function GET(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode listar os assinantes."
  );
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);

  const page = parsePositiveInt(searchParams.get("page"), 1, 10_000);
  const pageSize = parsePositiveInt(
    searchParams.get("pageSize"),
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );

  const statusParam = searchParams.get("status");
  let status: SubscriptionStatus | null = null;

  if (statusParam && statusParam !== "todos") {
    if (!isSubscriptionStatus(statusParam)) {
      return fail(
        `Status inválido. Use: ${SUBSCRIPTION_STATUSES.join(", ")}.`,
        400
      );
    }
    status = statusParam;
  }

  const search = sanitizeSearch(searchParams.get("search") ?? "");

  let result = await fetchPage({
    withSubscriptions: true,
    search,
    status,
    page,
    pageSize,
  });

  // Base sem a migração 12: lista o básico e sinaliza a pendência em vez de
  // devolver erro (o Super Admin ainda consegue ver as lojas cadastradas).
  let schemaPending = false;

  if (result.error && isMissingSubscriptionColumns(result.error)) {
    schemaPending = true;
    result = await fetchPage({
      withSubscriptions: false,
      search,
      status: null,
      page,
      pageSize,
    });
  }

  if (result.error) {
    console.error(
      "[admin/subscriptions] falha ao listar os assinantes",
      result.error
    );
    return fail("Não foi possível carregar os assinantes.", 500);
  }

  // Normaliza colunas ausentes no fallback (tipos opcionais).
  const establishments = (result.data ?? []).map((row) => ({
    subscription_status: null,
    trial_ends_at: null,
    plan_id: null,
    subscription_id: null,
    customer_payment_id: null,
    ...row,
  }));

  const total = result.count ?? 0;

  return NextResponse.json({
    establishments,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    },
    schemaPending,
  });
}

/** Resposta 500 quando a migração de assinaturas (12) está pendente. */
function migrationPending() {
  return fail(
    "As colunas de assinatura ainda não existem no banco. Execute a migração " +
      "20261110000012_add_subscriptions_to_establishments.sql no SQL Editor " +
      "do Supabase.",
    500
  );
}

/**
 * PATCH — ações manuais do Super Admin sobre uma loja.
 *
 * - `activate`: status `active` + `trial_ends_at` renovado por 30 dias;
 * - `extend_trial`: status `trialing` + `trial_ends_at` +15 dias (ou `days`);
 * - `cancel`: status `canceled` (bloqueia o painel pelo paywall);
 * - `set_status`: define `subscription_status` e, opcionalmente, a data.
 */
export async function PATCH(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode alterar assinaturas."
  );
  if (!guard.ok) return guard.response;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return fail("Corpo da requisição inválido (JSON esperado).", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Corpo da requisição inválido.", 400);
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return fail("Informe o `id` do estabelecimento.", 400);

  const action: AdminAction | null = isAdminAction(body.action)
    ? body.action
    : body.subscription_status !== undefined
      ? "set_status"
      : null;

  if (!action) {
    return fail(
      "Informe uma ação válida: activate, extend_trial, cancel ou set_status.",
      400
    );
  }

  const adminClient = createAdminClient();

  const { data: currentData, error: currentError } = await adminClient
    .from("establishments")
    .select("id, name, subscription_status, trial_ends_at")
    .eq("id", id)
    .maybeSingle();

  if (currentError) {
    if (isMissingSubscriptionColumns(currentError)) return migrationPending();

    console.error(
      "[admin/subscriptions] falha ao carregar o estabelecimento",
      currentError
    );
    return fail("Não foi possível carregar o estabelecimento.", 500);
  }

  const current = currentData as {
    id: string;
    subscription_status: SubscriptionStatus | null;
    trial_ends_at: string | null;
  } | null;

  if (!current) return fail("Estabelecimento não encontrado.", 404);

  const now = new Date();
  let nextStatus: SubscriptionStatus = current.subscription_status ?? "trialing";
  let nextTrialEndsAt: string | null | undefined;
  let message = "Assinatura atualizada.";

  switch (action) {
    case "activate": {
      nextStatus = "active";
      nextTrialEndsAt = extendSubscriptionDate(
        current.trial_ends_at,
        MANUAL_ACTIVATION_DAYS,
        now
      );
      message = `Plano ativado e acesso renovado por ${MANUAL_ACTIVATION_DAYS} dias.`;
      break;
    }

    case "extend_trial": {
      let days = TRIAL_EXTENSION_DAYS;

      if (body.days !== undefined) {
        if (
          typeof body.days !== "number" ||
          !Number.isFinite(body.days) ||
          !Number.isInteger(body.days) ||
          body.days < 1 ||
          body.days > MAX_TRIAL_EXTENSION_DAYS
        ) {
          return fail(
            `Informe uma quantidade de dias entre 1 e ${MAX_TRIAL_EXTENSION_DAYS}.`,
            400
          );
        }
        days = body.days;
      }

      nextStatus = "trialing";
      nextTrialEndsAt = extendSubscriptionDate(
        current.trial_ends_at,
        days,
        now
      );
      message = `Trial prorrogado por ${days} dias.`;
      break;
    }

    case "cancel": {
      nextStatus = "canceled";
      // Mantém a data atual: o vencimento continua registrado no histórico.
      nextTrialEndsAt = undefined;
      message = "Assinatura cancelada. O acesso ao painel foi bloqueado.";
      break;
    }

    case "set_status": {
      if (!isSubscriptionStatus(body.subscription_status)) {
        return fail(
          `Status inválido. Use: ${SUBSCRIPTION_STATUSES.join(", ")}.`,
          400
        );
      }

      nextStatus = body.subscription_status;

      if (body.trial_ends_at !== undefined && body.trial_ends_at !== null) {
        if (typeof body.trial_ends_at !== "string") {
          return fail("Data de vencimento inválida.", 400);
        }

        const parsed = new Date(body.trial_ends_at);
        if (!Number.isFinite(parsed.getTime())) {
          return fail("Data de vencimento inválida.", 400);
        }

        nextTrialEndsAt = parsed.toISOString();
      }

      message = "Assinatura atualizada.";
      break;
    }
  }

  const patch: Record<string, unknown> = { subscription_status: nextStatus };
  if (nextTrialEndsAt !== undefined) patch.trial_ends_at = nextTrialEndsAt;

  const { data: updated, error: updateError } = await adminClient
    .from("establishments")
    .update(patch)
    .eq("id", id)
    .select(SUBSCRIBER_COLUMNS)
    .single();

  if (updateError) {
    if (isMissingSubscriptionColumns(updateError)) return migrationPending();

    console.error("[admin/subscriptions] falha ao atualizar a assinatura", updateError);
    return fail("Não foi possível atualizar a assinatura.", 500);
  }

  return NextResponse.json({ establishment: updated, message });
}


