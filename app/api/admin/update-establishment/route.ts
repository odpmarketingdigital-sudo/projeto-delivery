import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";

/** Status permitido na atualização via API. */
const ALLOWED_STATUSES = ["ativo", "inativo"] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

function isAllowedStatus(value: unknown): value is AllowedStatus {
  return (
    typeof value === "string" &&
    (ALLOWED_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * PUT /api/admin/update-establishment
 *
 * Atualiza um estabelecimento existente (nome, responsável, telefone e status).
 * Também sincroniza os dados no profile vinculado (user_id) e, se uma nova
 * senha for informada, redefine-a na conta de acesso (Supabase Auth).
 *
 * Segurança:
 * - Exige Super Admin (ver lib/supabase/adminGuard.ts).
 * - Escritas via service role key (bypass de RLS).
 *
 * Body: { id, name, owner_name, phone?, status, password? }
 */
export async function PUT(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode editar estabelecimentos."
  );
  if (!guard.ok) return guard.response;

  // 1) Valida o corpo da requisição.
  let body: {
    id?: string;
    name?: string;
    owner_name?: string;
    phone?: string;
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
  const ownerName = body.owner_name?.trim();
  const phone = body.phone?.trim() ?? "";
  const status = body.status;
  const password = body.password;

  if (!id || !name || !ownerName) {
    return NextResponse.json(
      { error: "Preencha nome da loja e responsável." },
      { status: 400 }
    );
  }

  if (!isAllowedStatus(status)) {
    return NextResponse.json({ error: "Status inválido." }, { status: 400 });
  }

  // A senha é opcional; se informada, precisa seguir a regra mínima do Auth.
  if (password !== undefined && password !== "" && password.length < 6) {
    return NextResponse.json(
      { error: "A nova senha deve ter ao menos 6 caracteres." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // 2) Atualiza o estabelecimento e retorna a linha atualizada.
  const { data: updated, error: updateError } = await adminClient
    .from("establishments")
    .update({ name, owner_name: ownerName, phone, status })
    .eq("id", id)
    .select()
    .single();

  if (updateError || !updated) {
    const notFound = updateError?.code === "PGRST116";
    return NextResponse.json(
      {
        error: notFound
          ? "Estabelecimento não encontrado."
          : updateError?.message ?? "Falha ao atualizar o estabelecimento.",
      },
      { status: notFound ? 404 : 400 }
    );
  }

  // 3) Sincroniza o profile vinculado (mantém nome/estabelecimento coerentes).
  await adminClient
    .from("profiles")
    .update({ name: ownerName, establishment: name })
    .eq("id", updated.user_id);

  // 4) Se informada, redefine a senha da conta de acesso no Supabase Auth.
  if (password) {
    const { error: pwError } = await adminClient.auth.admin.updateUserById(
      updated.user_id,
      { password }
    );

    if (pwError) {
      return NextResponse.json(
        {
          error: `Dados salvos, mas falha ao redefinir a senha: ${pwError.message}`,
        },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({ establishment: updated }, { status: 200 });
}
