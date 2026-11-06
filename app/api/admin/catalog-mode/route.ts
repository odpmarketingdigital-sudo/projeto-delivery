import { NextResponse } from "next/server";
import { revalidatePublicStore } from "@/lib/storeAvailability";
import { createAdminClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";

/**
 * SQL de migração pendente (coluna do Modo catálogo).
 * Repetido nas respostas de erro para o Super Admin conseguir resolver sozinho.
 */
const CATALOG_MODE_SQL =
  "alter table public.establishments add column if not exists catalog_mode_allowed boolean not null default false;";

/** Coluna `catalog_mode_allowed` ainda não migrada? */
function isMissingCatalogColumn(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  return (
    /catalog_mode_allowed/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

/** Coluna `direct_whatsapp_checkout` ainda não migrada? (bases legadas) */
function isMissingDirectCheckoutColumn(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  return (
    /direct_whatsapp_checkout/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

/**
 * PUT /api/admin/catalog-mode
 *
 * Libera/bloqueia o "Modo catálogo" (pedido/orçamento direto no WhatsApp) de um
 * estabelecimento. A permissão é exclusiva do Super Admin: a coluna
 * `catalog_mode_allowed` (migração 20261110000025) nasce `false` e só muda por
 * esta rota.
 *
 * Ao revogar, a preferência da loja (`direct_whatsapp_checkout`) também volta
 * para `false` — assim o painel do lojista e o cardápio público nunca ficam com
 * uma configuração "ligada" que não pode ser usada.
 *
 * Segurança:
 * - Exige Super Admin (ver lib/supabase/adminGuard.ts).
 * - Escritas via service role key (bypass de RLS).
 *
 * Body: { id, allowed }
 */
export async function PUT(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode liberar o Modo catálogo."
  );
  if (!guard.ok) return guard.response;

  let body: { id?: string; allowed?: boolean };
  try {
    body = (await request.json()) as { id?: string; allowed?: boolean };
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const id = body.id?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "Informe o estabelecimento (id) a ser atualizado." },
      { status: 400 }
    );
  }
  if (typeof body.allowed !== "boolean") {
    return NextResponse.json(
      { error: "allowed deve ser true ou false." },
      { status: 400 }
    );
  }

  const allowed = body.allowed;
  const adminClient = createAdminClient();

  /** Campos gravados: a liberação e, ao revogar, o desligamento da loja. */
  const buildFields = (withDirectCheckout: boolean): Record<string, unknown> => ({
    catalog_mode_allowed: allowed,
    ...(allowed || !withDirectCheckout
      ? {}
      : { direct_whatsapp_checkout: false }),
  });

  const runUpdate = (fields: Record<string, unknown>) =>
    adminClient
      .from("establishments")
      .update(fields)
      .eq("id", id)
      .select("id, user_id, name, slug, status, catalog_mode_allowed")
      .single();

  let { data: updated, error: updateError } = await runUpdate(buildFields(true));

  // Base sem a migração 17 (`direct_whatsapp_checkout`): tenta de novo gravando
  // apenas a liberação — o modo catálogo nem existe nessa base.
  if (updateError && isMissingDirectCheckoutColumn(updateError)) {
    ({ data: updated, error: updateError } = await runUpdate(buildFields(false)));
  }

  if (updateError || !updated) {
    if (isMissingCatalogColumn(updateError)) {
      return NextResponse.json(
        {
          error:
            "A coluna do Modo catálogo ainda não existe no banco. " +
            "Execute a migração 20261110000025_add_catalog_mode_allowed.sql no SQL Editor do Supabase. " +
            `SQL: ${CATALOG_MODE_SQL}`,
        },
        { status: 400 }
      );
    }

    const notFound = updateError?.code === "PGRST116";
    return NextResponse.json(
      {
        error: notFound
          ? "Estabelecimento não encontrado."
          : updateError?.message ?? "Falha ao atualizar o Modo catálogo.",
      },
      { status: notFound ? 404 : 400 }
    );
  }

  // A vitrine muda de fluxo (checkout x WhatsApp): invalida o cache de `/[slug]`.
  revalidatePublicStore(updated.slug);

  return NextResponse.json({ establishment: updated }, { status: 200 });
}
