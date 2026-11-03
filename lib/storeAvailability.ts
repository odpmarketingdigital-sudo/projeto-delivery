/**
 * Disponibilidade pública do cardápio (`/[slug]`).
 *
 * Fonte única da regra "a loja está no ar?":
 *  - `establishments.status`         → `ativo` | `inativo` (liga/desliga manual
 *    do Super Admin);
 *  - `establishments.subscription_status` → `canceled` derruba a vitrine mesmo
 *    com `status = 'ativo'` (o webhook do Asaas encerra a assinatura sem mexer
 *    no status da loja);
 *  - atraso maior que `OVERDUE_GRACE_DAYS` (15 dias) → derruba a vitrine e
 *    persiste a suspensão (`status = 'inativo'` + `overdue_suspended_at`).
 *    A conta é feita em `lib/storeEligibility.ts`, a partir do vencimento da
 *    fatura em aberto gravado pelo webhook do Asaas.
 *
 * O nome da loja é devolvido junto para que a página pública consiga exibir
 * "loja fora do ar" de forma amigável em vez de um 404 genérico.
 *
 * Sempre use o cliente **service role** (`createAdminClient`): a vitrine é
 * anônima e as policies públicas de RLS só enxergam linhas `status = 'ativo'`,
 * ou seja, escondem justamente o caso que precisamos detectar aqui.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/server";
import {
  evaluateStoreEligibility,
  type StoreEligibilityReason,
} from "@/lib/storeEligibility";

/** Estado da loja para o visitante da vitrine. */
export type PublicStoreState = "online" | "offline" | "missing";

/** Resultado de `resolvePublicStore`. */
export interface PublicStore {
  state: PublicStoreState;
  /** Nome da loja (null no slug inexistente ou sem nome cadastrado). */
  name: string | null;
  /** Motivo da indisponibilidade — para log/diagnóstico, nunca para o cliente. */
  reason: StoreEligibilityReason | null;
  /** Dias de atraso da assinatura (0 quando em dia). */
  daysOverdue: number;
  /** Vencimento da fatura em aberto (`YYYY-MM-DD`), quando houver. */
  dueDate: string | null;
}

/**
 * Colunas da validação pública (status + assinatura + cobrança).
 * `payment_due_date` é da migração 20261110000023 — bases mais antigas caem
 * para `STORE_COLUMNS` e, por último, para `LEGACY_STORE_COLUMNS`.
 */
const BILLING_STORE_COLUMNS =
  "id, name, slug, status, subscription_status, trial_ends_at, subscription_expires_at, payment_due_date";

/** Colunas da validação pública sem as de cobrança (migração 20261110000019). */
const STORE_COLUMNS = "id, name, slug, status, subscription_status";

/** Colunas mínimas em bases sem a migração de assinaturas (20261110000012). */
const LEGACY_STORE_COLUMNS = "id, name, slug, status";

/** Linha crua de `establishments` usada na validação. */
interface StoreRow {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  subscription_status?: string | null;
  trial_ends_at?: string | null;
  subscription_expires_at?: string | null;
  payment_due_date?: string | null;
}

/**
 * Regra única de visibilidade: a loja precisa estar `ativo`, sem a assinatura
 * cancelada e sem atraso acima da carência de 15 dias.
 *
 * `trialing`, `active` e `past_due` dentro da carência mantêm o cardápio no ar
 * (o inadimplente ainda pode vender enquanto o gateway não encerra a
 * assinatura).
 */
export function isStorePubliclyVisible(store: {
  status?: string | null;
  subscription_status?: string | null;
  trial_ends_at?: string | null;
  subscription_expires_at?: string | null;
  payment_due_date?: string | null;
}): boolean {
  return evaluateStoreEligibility(store).isEligible;
}

/**
 * `true` quando o erro do PostgREST indica coluna ausente (migração pendente).
 * Nesse caso a leitura recua para um conjunto menor de colunas em vez de
 * derrubar a vitrine.
 */
function isMissingColumn(error: { message?: string | null } | null): boolean {
  return /subscription_status|trial_ends_at|subscription_expires_at|payment_due_date/i.test(
    error?.message ?? ""
  );
}

/**
 * Resolve o estado público da loja dona do `slug`.
 *
 * - `missing`  → slug não cadastrado (a página responde 404);
 * - `offline`  → loja inativa, assinatura cancelada ou atraso > 15 dias;
 * - `online`   → cardápio liberado.
 *
 * Atraso acima da carência também **persiste a suspensão** (`status =
 * 'inativo'` + `overdue_suspended_at`), como fallback dinâmico caso o webhook
 * do Asaas não tenha sido entregue. A escrita é best-effort: se falhar, o
 * visitante continua vendo a página de "loja indisponível".
 *
 * Falha de banco é registrada no log e tratada como `missing`, mantendo o
 * comportamento anterior (404) em vez de expor um erro interno na vitrine.
 */
export async function resolvePublicStore(slug: string): Promise<PublicStore> {
  const normalized = slug?.trim() ?? "";
  if (!normalized) {
    return {
      state: "missing",
      name: null,
      reason: null,
      daysOverdue: 0,
      dueDate: null,
    };
  }

  const adminClient = createAdminClient();

  const run = (columns: string) =>
    adminClient
      .from("establishments")
      .select(columns)
      .eq("slug", normalized)
      .limit(1)
      .maybeSingle();

  // 1) leitura completa → 2) sem as colunas de cobrança → 3) base legada.
  // Cada recuo só acontece quando o PostgREST acusa coluna ausente (migração
  // pendente); erro real interrompe a sequência e vira `missing`.
  let row: StoreRow | null = null;
  let lastError: { message?: string | null } | null = null;

  for (const columns of [
    BILLING_STORE_COLUMNS,
    STORE_COLUMNS,
    LEGACY_STORE_COLUMNS,
  ]) {
    const result = await run(columns);

    if (!result.error) {
      row = (result.data ?? null) as StoreRow | null;
      lastError = null;
      break;
    }

    lastError = result.error;
    if (!isMissingColumn(result.error)) break;
  }

  if (lastError) {
    console.error(
      `[storeAvailability] falha ao resolver a loja "${normalized}"`,
      lastError
    );
    return {
      state: "missing",
      name: null,
      reason: null,
      daysOverdue: 0,
      dueDate: null,
    };
  }

  if (!row) {
    return {
      state: "missing",
      name: null,
      reason: null,
      daysOverdue: 0,
      dueDate: null,
    };
  }

  const name = row.name?.trim() || null;
  const eligibility = evaluateStoreEligibility(row);

  if (!eligibility.isEligible) {
    // Fallback dinâmico: o webhook pode não ter marcado a suspensão (evento
    // perdido ou base sem a coluna). Persistimos aqui para que o painel e os
    // relatórios reflitam o estado real.
    if (eligibility.requiresSuspension && row.id) {
      await suspendStoreForOverdue(adminClient, row.id, eligibility.daysOverdue);
    }

    console.warn(
      `[storeAvailability] loja "${normalized}" fora do ar (motivo: ${
        eligibility.reason
      }${eligibility.daysOverdue ? `, ${eligibility.daysOverdue} dias de atraso` : ""})`
    );

    return {
      state: "offline",
      name,
      reason: eligibility.reason,
      daysOverdue: eligibility.daysOverdue,
      dueDate: eligibility.dueDate,
    };
  }

  return {
    state: "online",
    name,
    reason: null,
    daysOverdue: eligibility.daysOverdue,
    dueDate: eligibility.dueDate,
  };
}

/**
 * Persiste a suspensão automática por inadimplência.
 *
 * Grava `status = 'inativo'` e `overdue_suspended_at` (para distinguir da
 * desativação manual do Super Admin e permitir a reativação automática no
 * pagamento). Só toca lojas ainda `ativo`, então reenvios/repetições são
 * inofensivos.
 *
 * Best-effort: nunca lança.
 *
 * @returns `true` quando a loja realmente foi suspensa nesta chamada.
 */
export async function suspendStoreForOverdue(
  admin: SupabaseClient,
  establishmentId: string,
  daysOverdue?: number
): Promise<boolean> {
  const id = establishmentId?.trim();
  if (!id) return false;

  const { data, error } = await admin
    .from("establishments")
    .update({
      status: "inativo",
      overdue_suspended_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "ativo")
    .select("id");

  if (!error) {
    const changed = Array.isArray(data) && data.length > 0;
    if (changed) {
      console.warn(
        `[storeAvailability] loja ${id} suspensa por atraso${
          typeof daysOverdue === "number" ? ` de ${daysOverdue} dias` : ""
        }`
      );
    }
    return changed;
  }

  // Base sem a migração 20261110000023: suspende só com o status.
  if (/overdue_suspended_at/i.test(error.message ?? "")) {
    const fallback = await admin
      .from("establishments")
      .update({ status: "inativo" })
      .eq("id", id)
      .eq("status", "ativo")
      .select("id");

    if (!fallback.error) {
      const changed =
        Array.isArray(fallback.data) && fallback.data.length > 0;
      if (changed) {
        console.warn(
          "[storeAvailability] migração 20261110000023 pendente — loja suspensa sem registrar overdue_suspended_at"
        );
      }
      return changed;
    }
  }

  console.error(`[storeAvailability] falha ao suspender a loja ${id}`, error);
  return false;
}


/**
 * Descarta o cache das rotas públicas da loja depois de uma mudança de status.
 *
 * Hoje `/[slug]` é renderizada a cada requisição (segmento dinâmico +
 * `instant = false`), mas o App Router mantém cache de RSC/CDN e esse cache
 * precisa ser invalidado explicitamente para que o cardápio saia do ar (ou
 * volte) no mesmo instante em que o painel muda o status.
 *
 * Só pode ser chamado de Route Handlers / Server Actions — nunca durante a
 * renderização de um componente.
 */
export function revalidatePublicStore(slug: string | null | undefined): void {
  const clean = typeof slug === "string" ? slug.trim() : "";
  if (!clean) return;

  try {
    revalidatePath(`/${clean}`);
    revalidatePath(`/${clean}/checkout`);
  } catch (error) {
    // Cache não invalidado não pode derrubar a operação principal (ex.: o
    // pagamento já foi confirmado no gateway).
    console.error(
      `[storeAvailability] falha ao revalidar a loja "${clean}"`,
      error
    );
  }
}

/**
 * Devolve a loja ao ar depois de um pagamento aprovado.
 *
 * Regra: só reativa quem foi desativado automaticamente — pelo cancelamento
 * (`canceled_at`, gravado por `/api/billing/cancel`) ou pela suspensão por
 * atraso (`overdue_suspended_at`, gravado pelo webhook/`/[slug]`). Lojas
 * desligadas manualmente pelo Super Admin continuam offline até uma ação
 * explícita do suporte.
 *
 * O pagamento também limpa `payment_due_date`, encerrando a contagem de dias
 * de atraso.
 *
 * Best-effort: nunca lança — o pagamento já foi confirmado e a loja pode ser
 * reconciliada manualmente pelo painel em caso de falha.
 *
 * @returns `true` quando a loja realmente voltou para `ativo`.
 */
export async function restoreStoreAfterPayment(
  admin: SupabaseClient,
  establishmentId: string
): Promise<boolean> {
  const id = establishmentId?.trim();
  if (!id) return false;

  /**
   * Tentativas em ordem decrescente de colunas. Cada recuo cobre uma migração
   * pendente (20261110000023 e depois 20261110000022) sem quebrar o pagamento.
   */
  const attempts: {
    patch: Record<string, string | null>;
    /** Filtro PostgREST; `null` usa `status = 'inativo'`. */
    filter: string | null;
    pendingMigration: string | null;
  }[] = [
    {
      patch: {
        status: "ativo",
        canceled_at: null,
        overdue_suspended_at: null,
        payment_due_date: null,
      },
      filter: "canceled_at.not.is.null,overdue_suspended_at.not.is.null",
      pendingMigration: null,
    },
    {
      patch: { status: "ativo", canceled_at: null },
      filter: "canceled_at.not.is.null",
      pendingMigration:
        "migração 20261110000023 pendente — loja reativada sem limpar overdue_suspended_at",
    },
    {
      patch: { status: "ativo" },
      filter: null,
      pendingMigration:
        "migração 20261110000022 pendente — loja reativada sem limpar canceled_at",
    },
  ];

  let lastError: { message?: string | null } | null = null;

  for (const attempt of attempts) {
    const base = admin.from("establishments").update(attempt.patch).eq("id", id);
    const filtered = attempt.filter
      ? base.or(attempt.filter)
      : base.eq("status", "inativo");

    const { data, error } = await filtered.select("id");

    if (!error) {
      const changed = Array.isArray(data) && data.length > 0;
      if (changed && attempt.pendingMigration) {
        console.warn(`[storeAvailability] ${attempt.pendingMigration}`);
      }
      return changed;
    }

    lastError = error;

    // Erro que não é de coluna ausente: não há por que insistir.
    if (!/canceled_at|overdue_suspended_at|payment_due_date/i.test(error.message ?? "")) {
      break;
    }
  }

  console.error(`[storeAvailability] falha ao reativar a loja ${id}`, lastError);
  return false;
}

