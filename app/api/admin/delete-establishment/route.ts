import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";

/**
 * DELETE /api/admin/delete-establishment
 *
 * Exclui um estabelecimento. A exclusão é feita removendo a conta de acesso
 * em `auth.users` — o `on delete cascade` remove o registro em `establishments`
 * e o profile vinculado.
 *
 * Segurança:
 * - Exige Super Admin (ver lib/supabase/adminGuard.ts).
 * - Impede que o Super Admin exclua a conta da própria sessão (auto-delete).
 *
 * Body: { id }
 */
export async function DELETE(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode excluir estabelecimentos."
  );
  if (!guard.ok) return guard.response;

  // 1) Valida o corpo da requisição.
  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const id = body.id?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "Informe o id do estabelecimento." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // 2) Localiza o estabelecimento para obter o user_id da conta de acesso.
  const { data: establishment, error: findError } = await adminClient
    .from("establishments")
    .select("id, user_id, name")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o estabelecimento." },
      { status: 400 }
    );
  }

  if (!establishment) {
    return NextResponse.json(
      { error: "Estabelecimento não encontrado." },
      { status: 404 }
    );
  }

  // 3) Impede auto-exclusão da conta em uso.
  if (establishment.user_id === guard.user.id) {
    return NextResponse.json(
      { error: "Você não pode excluir o estabelecimento da própria conta." },
      { status: 400 }
    );
  }

  // 4) Exclui a conta de acesso (cascade remove establishments + profiles).
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(
    establishment.user_id
  );

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message ?? "Falha ao excluir o estabelecimento." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}
