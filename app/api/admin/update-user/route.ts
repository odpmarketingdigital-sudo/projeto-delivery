import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";

/** Papéis que o Super Admin pode atribuir (nunca confie no papel do cliente). */
const ALLOWED_ROLES = ["admin", "super_admin"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

/** Status de conta aceitos (espelham o CHECK do schema em `profiles`). */
const ALLOWED_STATUS = ["ativo", "inativo"] as const;
type AllowedStatus = (typeof ALLOWED_STATUS)[number];

function isAllowedRole(value: unknown): value is AllowedRole {
  return (
    typeof value === "string" &&
    (ALLOWED_ROLES as readonly string[]).includes(value)
  );
}

function isAllowedStatus(value: unknown): value is AllowedStatus {
  return (
    typeof value === "string" &&
    (ALLOWED_STATUS as readonly string[]).includes(value)
  );
}

/**
 * PUT /api/admin/update-user
 *
 * Atualiza os dados de um usuário/estabelecimento existente.
 *
 * Segurança:
 * - Exige um usuário autenticado (sessão válida via cookies).
 * - Exige que o requisitante seja Super Admin, verificado via
 *   `user_metadata.role` e/ou `profiles.role` (service role) — ver
 *   `lib/supabase/adminGuard.ts`.
 * - As escritas usam a service role key (bypass de RLS), pois o Super Admin
 *   não possui política de UPDATE sobre perfis de terceiros.
 *
 * Body: { id, name, establishment, role, status, password? }
 * - `password` é opcional: quando informado (>= 6 caracteres), redefine a
 *   senha em auth e sincroniza os metadados do usuário.
 */
export async function PUT(request: Request) {
  // 1-3) Autentica e autoriza: exige sessão válida + Super Admin.
  //      A verificação consulta `user_metadata.role` e `profiles` (service
  //      role), evitando bloqueios de RLS no servidor.
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode editar usuários."
  );
  if (!guard.ok) return guard.response;

  // 4) Valida o corpo da requisição.
  let body: {
    id?: string;
    name?: string;
    establishment?: string;
    role?: string;
    status?: string;
    password?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const id = body.id?.trim();
  const name = body.name?.trim();
  const establishment = body.establishment?.trim() ?? "";
  const role = body.role;
  const status = body.status ?? "ativo";
  const password = body.password?.trim() ?? "";

  if (!id) {
    return NextResponse.json(
      { error: "ID do usuário é obrigatório." },
      { status: 400 }
    );
  }
  if (!name) {
    return NextResponse.json(
      { error: "O nome do responsável é obrigatório." },
      { status: 400 }
    );
  }
  if (!isAllowedRole(role)) {
    return NextResponse.json(
      { error: "Papel (role) inválido." },
      { status: 400 }
    );
  }
  if (!isAllowedStatus(status)) {
    return NextResponse.json(
      { error: "Status inválido." },
      { status: 400 }
    );
  }
  // A senha é opcional na edição; se informada, precisa ter ao menos 6 caracteres.
  if (password.length > 0 && password.length < 6) {
    return NextResponse.json(
      { error: "A senha deve ter ao menos 6 caracteres." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // 5) Atualiza os dados de exibição/permissão na tabela `profiles`.
  const { error: updateError } = await adminClient
    .from("profiles")
    .update({ name, establishment, role, status })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json(
      { error: updateError.message || "Falha ao atualizar o perfil." },
      { status: 400 }
    );
  }

  // 6) Se uma nova senha foi informada, redefine em auth e sincroniza os
  //    metadados (o trigger só age no INSERT, por isso atualizamos aqui).
  if (password.length > 0) {
    const { error: authUpdateError } =
      await adminClient.auth.admin.updateUserById(id, {
        password,
        user_metadata: { name, establishment, role },
      });

    if (authUpdateError) {
      // O perfil já foi atualizado; sinaliza que a senha não mudou.
      return NextResponse.json(
        {
          warning:
            "Dados atualizados, mas houve uma falha ao redefinir a senha. Tente novamente.",
          error: authUpdateError.message,
        },
        { status: 207 }
      );
    }
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
