/**
 * Persistência do estabelecimento do usuário logado.
 *
 * Centraliza as duas entradas de cadastro:
 *  - `POST /api/signup` (e-mail + senha), que cria o usuário e a loja juntos;
 *  - `POST /api/signup/establishment` (onboarding pós-Google), que completa a
 *    loja de um usuário já autenticado.
 *
 * Regras:
 *  - um usuário tem no máximo UM estabelecimento (`establishments.user_id`);
 *  - salvar de novo ATUALIZA a loja existente (idempotente);
 *  - o papel em `profiles` vira `admin` (quem cria loja é dono de loja), sem
 *    rebaixar um `super_admin`;
 *  - o JWT recebe `role: "admin"` + `onboarding_complete: true` para que o
 *    middleware/painel reconheçam a conta sem consultar o banco.
 *
 * Sempre usar com o cliente **service role** (`createAdminClient`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentType } from "@/lib/registration";
import { addTrialDays } from "@/lib/subscriptions";

/** Dados mínimos do estabelecimento usados nas telas de cadastro/login. */
export interface EstablishmentSummary {
  id: string;
  name: string;
  slug: string | null;
  owner_name: string | null;
  status: string | null;
  /** Fim do trial (coluna da migração 12; ausente em bancos legados). */
  trial_ends_at?: string | null;
  subscription_status?: string | null;
}

/** Entrada normalizada de `saveEstablishmentForUser`. */
export interface SaveEstablishmentInput {
  name: string;
  ownerName: string;
  email: string;
  /** WhatsApp só com dígitos (gravado em `phone` e `whatsapp`). */
  whatsapp: string;
  documentType: DocumentType;
  /** Documento só com dígitos. */
  documentNumber: string;
  /** Slug já normalizado, sem o prefixo `ipepper.com.br/`. */
  slug: string;
}

/** Códigos de falha tratados pelas rotas (viram status HTTP). */
export type EstablishmentSaveErrorCode =
  | "slug_taken"
  | "migration_pending"
  | "conflict"
  | "unknown";

/** Resultado de `saveEstablishmentForUser`. */
export type SaveEstablishmentResult =
  | {
      ok: true;
      /** `true` quando a loja foi criada agora; `false` em atualização. */
      created: boolean;
      establishment: EstablishmentSummary;
      /**
       * Aviso não bloqueante (ex.: colunas de documento ainda não migradas —
       * a loja foi salva, mas o CPF/CNPJ não pôde ser gravado).
       */
      warning?: string;
    }
  | {
      ok: false;
      status: number;
      code: EstablishmentSaveErrorCode;
      error: string;
      /** Campo do formulário que originou a falha (quando aplicável). */
      field?: "slug" | "document_number";
    };

/** Colunas sempre presentes na tabela `establishments`. */
const SUMMARY_COLUMNS = "id, name, slug, owner_name, status";

/** Colunas de assinatura (migração 20261110000012). */
const SUMMARY_COLUMNS_WITH_TRIAL = `${SUMMARY_COLUMNS}, trial_ends_at, subscription_status`;

/** Mensagem para bancos sem as colunas de CPF/CNPJ. */
const DOCUMENT_MIGRATION_WARNING =
  "Estabelecimento salvo, mas as colunas de CPF/CNPJ ainda não existem no banco. " +
  "Execute a migração 20261110000020_add_document_to_establishments.sql.";

/** Converte a linha do PostgREST no resumo tipado (tolerante a nulos). */
function readSummary(row: unknown): EstablishmentSummary {
  const data = (row ?? {}) as Record<string, unknown>;

  return {
    id: typeof data.id === "string" ? data.id : "",
    name: typeof data.name === "string" ? data.name : "",
    slug: typeof data.slug === "string" && data.slug ? data.slug : null,
    owner_name:
      typeof data.owner_name === "string" && data.owner_name
        ? data.owner_name
        : null,
    status: typeof data.status === "string" ? data.status : null,
    trial_ends_at:
      typeof data.trial_ends_at === "string" ? data.trial_ends_at : null,
    subscription_status:
      typeof data.subscription_status === "string"
        ? data.subscription_status
        : null,
  };
}

/** `true` quando o erro indica colunas de documento ausentes (migração 20). */
function isMissingDocumentColumns(
  error: { message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  return (
    /(document_type|document_number)/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

/** `true` quando o erro indica que as colunas de assinatura não existem. */
function isMissingSubscriptionColumns(
  error: { message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  return (
    /(trial_ends_at|subscription_status|subscription_id|customer_payment_id|plan_id)/i.test(
      message
    ) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

/**
 * Estabelecimento do usuário (ou `null` se ele ainda não tem loja).
 *
 * É o "check" usado pelo `/auth/callback` e por `/completar-cadastro` para
 * decidir entre onboarding e painel.
 */
export async function findEstablishmentForUser(
  admin: SupabaseClient,
  userId: string
): Promise<EstablishmentSummary | null> {
  const { data, error } = await admin
    .from("establishments")
    .select(SUMMARY_COLUMNS)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[establishments] falha ao buscar loja do usuário", error);
    return null;
  }

  return data ? readSummary(data) : null;
}

/**
 * `true` quando o slug já pertence a outra loja.
 *
 * `ignoreId` permite que a própria loja salve novamente com o mesmo slug.
 * Erros de leitura são tratados como "livre": o índice único do banco é a
 * última palavra (a rota traduz o 23505 em mensagem amigável).
 */
export async function isSlugTaken(
  admin: SupabaseClient,
  slug: string,
  ignoreId?: string
): Promise<boolean> {
  let query = admin
    .from("establishments")
    .select("id")
    .eq("slug", slug)
    .limit(1);

  if (ignoreId) query = query.neq("id", ignoreId);

  const { data, error } = await query;

  if (error) return false;

  return Array.isArray(data) && data.length > 0;
}

/**
 * Sincroniza a conta do dono após salvar a loja:
 *  - `profiles.role` = `admin` (salvo se já for `super_admin`);
 *  - metadados do usuário (`role`, `establishment`, `onboarding_complete`).
 *
 * O papel em `profiles` é o que `AuthContext`/`PainelGuard` consultam para
 * liberar `/painel`; sem ele um usuário criado pelo Google (trigger cria
 * `cliente`) seria desconectado ao entrar no painel.
 *
 * Best effort: uma falha aqui não invalida a loja já salva.
 */
async function syncOwnerAccount(
  admin: SupabaseClient,
  userId: string,
  input: SaveEstablishmentInput
): Promise<void> {
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  const currentRole =
    profile && typeof (profile as { role?: unknown }).role === "string"
      ? ((profile as { role: string }).role as string)
      : null;

  const role = currentRole === "super_admin" ? "super_admin" : "admin";

  const { error: profileError } = await admin.from("profiles").upsert(
    {
      id: userId,
      name: input.ownerName,
      email: input.email,
      role,
      establishment: input.name,
    },
    { onConflict: "id" }
  );

  if (profileError) {
    console.error("[establishments] falha ao atualizar perfil", profileError);
  }

  const { error: authError } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: {
      role,
      establishment: input.name,
      onboarding_complete: true,
      name: input.ownerName,
    },
  });

  if (authError) {
    console.error("[establishments] falha ao atualizar metadados", authError);
  }
}

/** Traduz o erro de escrita (PostgREST) em resposta de negócio. */
function failureFromWrite(
  error: { code?: string | null; message?: string | null },
  slug: string
): SaveEstablishmentResult {
  if (isMissingSubscriptionColumns(error)) {
    return {
      ok: false,
      status: 500,
      code: "migration_pending",
      error:
        "As colunas de assinatura ainda não existem no banco. Execute a " +
        "migração 20261110000012_add_subscriptions_to_establishments.sql " +
        "no SQL Editor do Supabase.",
    };
  }

  // Corrida: outra loja tomou o slug entre a checagem e o insert.
  if (error.code === "23505" && /slug/i.test(error.message ?? "")) {
    return {
      ok: false,
      status: 409,
      code: "slug_taken",
      field: "slug",
      error: `O link "${slug}" já está em uso. Escolha outro.`,
    };
  }

  // CPF/CNPJ já vinculado a outra loja (índice único da migração 20).
  if (error.code === "23505" && /document_number/i.test(error.message ?? "")) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      field: "document_number",
      error: "Este CPF/CNPJ já está vinculado a outra loja na plataforma.",
    };
  }

  // Corrida: a mesma conta salvou duas lojas em paralelo (unique em user_id).
  if (error.code === "23505") {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      error: "Esta conta já possui um estabelecimento cadastrado.",
    };
  }

  console.error("[establishments] falha ao salvar loja", error);

  return {
    ok: false,
    status: 500,
    code: "unknown",
    error: error.message ?? "Não foi possível salvar o estabelecimento.",
  };
}

/**
 * Cria ou atualiza o estabelecimento do usuário.
 *
 * - Atualiza quando já existe loja (`user_id`), preservando assinatura/status.
 * - Cria com `status: "ativo"` e trial de `TRIAL_DAYS` (migração 12).
 * - Valida a unicidade do slug antes (mensagem amigável) e trata o 23505.
 * - Sincroniza `profiles`/metadados para liberar o painel.
 */
export async function saveEstablishmentForUser(
  admin: SupabaseClient,
  userId: string,
  input: SaveEstablishmentInput
): Promise<SaveEstablishmentResult> {
  const existing = await findEstablishmentForUser(admin, userId);

  if (await isSlugTaken(admin, input.slug, existing?.id)) {
    return {
      ok: false,
      status: 409,
      code: "slug_taken",
      field: "slug",
      error: `O link "${input.slug}" já está em uso. Escolha outro.`,
    };
  }

  const identity = {
    name: input.name,
    owner_name: input.ownerName,
    email: input.email,
    // `phone` é o campo histórico; `whatsapp` é o oficial (migração 6).
    phone: input.whatsapp,
    whatsapp: input.whatsapp,
    slug: input.slug,
  };

  const documents = {
    document_type: input.documentType,
    document_number: input.documentNumber,
  };

  if (existing) {
    const updated = await admin
      .from("establishments")
      .update({ ...identity, ...documents })
      .eq("id", existing.id)
      .select(SUMMARY_COLUMNS_WITH_TRIAL)
      .maybeSingle();

    let data = updated.data;
    let error = updated.error;
    let warning: string | undefined;

    if (error && isMissingDocumentColumns(error)) {
      warning = DOCUMENT_MIGRATION_WARNING;
      const retry = await admin
        .from("establishments")
        .update(identity)
        .eq("id", existing.id)
        .select(SUMMARY_COLUMNS_WITH_TRIAL)
        .maybeSingle();
      data = retry.data;
      error = retry.error;
    }

    if (error) return failureFromWrite(error, input.slug);
    if (!data) {
      return {
        ok: false,
        status: 500,
        code: "unknown",
        error: "Não foi possível salvar o estabelecimento.",
      };
    }

    await syncOwnerAccount(admin, userId, input);

    return { ok: true, created: false, establishment: readSummary(data), warning };
  }

  const created = await admin
    .from("establishments")
    .insert({
      user_id: userId,
      ...identity,
      ...documents,
      status: "ativo",
      subscription_status: "trialing",
      trial_ends_at: addTrialDays(),
    })
    .select(SUMMARY_COLUMNS_WITH_TRIAL)
    .single();

  let data = created.data;
  let error = created.error;
  let warning: string | undefined;

  if (error && isMissingDocumentColumns(error)) {
    warning = DOCUMENT_MIGRATION_WARNING;
    const retry = await admin
      .from("establishments")
      .insert({
        user_id: userId,
        ...identity,
        status: "ativo",
        subscription_status: "trialing",
        trial_ends_at: addTrialDays(),
      })
      .select(SUMMARY_COLUMNS_WITH_TRIAL)
      .single();
    data = retry.data;
    error = retry.error;
  }

  if (error) return failureFromWrite(error, input.slug);
  if (!data) {
    return {
      ok: false,
      status: 500,
      code: "unknown",
      error: "Não foi possível salvar o estabelecimento.",
    };
  }

  await syncOwnerAccount(admin, userId, input);

  return { ok: true, created: true, establishment: readSummary(data), warning };
}
