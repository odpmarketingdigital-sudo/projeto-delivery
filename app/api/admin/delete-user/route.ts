import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";

/**
 * DELETE /api/admin/delete-user
 *
 * Exclui um usuário/estabelecimento pelo id.
 *
 * Segurança:
 * - Exige um usuário autenticado (sessão válida via cookies).
 * - Exige que o requisitante seja Super Admin, verificado via
 *   `user_metadata.role` e/ou `profiles.role` (service role) — ver
 *   `lib/supabase/adminGuard.ts`.
 * - Impede que o Super Admin exclua a própria conta (evita lockout).
 *
 * A remoção do usuário em `auth.users` dispara o ON DELETE CASCADE da tabela
 * `profiles` (id referencia auth.users), removendo o perfil automaticamente.
 *
 * Body: { id }
 */
export async function DELETE(request: Request) {
  // 1-3) Autentica e autoriza: exige sessão válida + Super Admin.
  //      A verificação consulta `user_metadata.role` e `profiles` (service
  //      role), evitando bloqueios de RLS no servidor.
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode excluir usuários."
  );
  if (!guard.ok) return guard.response;
  const userId = guard.user.id;

  // 4) Valida o corpo da requisição.
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
      { error: "ID do usuário é obrigatório." },
      { status: 400 }
    );
  }

  // Proteção: não permitir auto-exclusão (o Super Admin se trancaria fora).
  if (id === userId) {
    return NextResponse.json(
      { error: "Você não pode excluir a sua própria conta." },
      { status: 400 }
    );
  }

  // 5) Exclui o usuário em auth (cascade remove a linha em `profiles`).
  const adminClient = createAdminClient();
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message || "Falha ao excluir o usuário." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}
