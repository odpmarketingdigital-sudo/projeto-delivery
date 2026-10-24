import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";

/** Papéis permitidos na criação via API (nunca confie no papel do cliente). */
const ALLOWED_ROLES = ["admin", "super_admin"] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

function isAllowedRole(value: unknown): value is AllowedRole {
  return (
    typeof value === "string" &&
    (ALLOWED_ROLES as readonly string[]).includes(value)
  );
}

/**
 * POST /api/admin/create-user
 *
 * Cria um novo administrador de estabelecimento usando a service role key.
 *
 * Segurança:
 * - Exige um usuário autenticado (sessão válida via cookies).
 * - Exige que o usuário autenticado seja Super Admin, verificado via
 *   `user_metadata.role` e/ou `profiles.role` (service role) — ver
 *   `lib/supabase/adminGuard.ts`.
 * - O papel enviado no corpo é validado contra uma lista permitida.
 *
 * Body: { name, establishment, email, password, role }
 */
export async function POST(request: Request) {
  // 1-3) Autentica e autoriza: exige sessão válida + Super Admin.
  //      A verificação consulta `user_metadata.role` e `profiles` (service
  //      role), evitando bloqueios de RLS no servidor.
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode criar usuários."
  );
  if (!guard.ok) return guard.response;

  // 4) Valida o corpo da requisição.
  let body: {
    name?: string;
    establishment?: string;
    email?: string;
    password?: string;
    role?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const name = body.name?.trim();
  const establishment = body.establishment?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  const role = body.role ?? "admin";

  if (!name || !email || !password) {
    return NextResponse.json(
      { error: "Preencha nome, e-mail e senha." },
      { status: 400 }
    );
  }

  if (!isAllowedRole(role)) {
    return NextResponse.json(
      { error: "Papel (role) inválido." },
      { status: 400 }
    );
  }

  if (password.length < 6) {
    return NextResponse.json(
      { error: "A senha deve ter ao menos 6 caracteres." },
      { status: 400 }
    );
  }

  // 5) Cria o usuário com o cliente administrativo (service role).
  const adminClient = createAdminClient();
  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        name,
        establishment: establishment ?? "",
        role,
      },
    });

  if (createError || !created.user) {
    return NextResponse.json(
      { error: createError?.message ?? "Falha ao criar o usuário." },
      { status: 400 }
    );
  }

  // 6) Garante o registro na tabela `profiles` (id = auth user id).
  //    Usa upsert para não falhar caso um trigger já tenha criado a linha.
  const { error: upsertError } = await adminClient
    .from("profiles")
    .upsert(
      {
        id: created.user.id,
        name,
        email,
        role,
        establishment: establishment ?? "",
      },
      { onConflict: "id" }
    );

  if (upsertError) {
    // O usuário auth foi criado, mas o perfil falhou. Retorna 207/500 para
    // que o Super Admin saiba que pode precisar corrigir o perfil manualmente.
    return NextResponse.json(
      {
        warning:
          "Usuário criado, mas houve uma falha ao salvar o perfil. Verifique a tabela profiles.",
        userId: created.user.id,
      },
      { status: 207 }
    );
  }

  return NextResponse.json(
    {
      user: {
        id: created.user.id,
        email: created.user.email,
        role,
      },
    },
    { status: 201 }
  );
}
