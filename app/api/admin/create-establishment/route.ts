import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";
import { generateUniqueSlug } from "@/lib/slug";

/** Status permitido na criação via API (nunca confie no valor do cliente). */
const ALLOWED_STATUSES = ["ativo", "inativo"] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

function isAllowedStatus(value: unknown): value is AllowedStatus {
  return (
    typeof value === "string" &&
    (ALLOWED_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * POST /api/admin/create-establishment
 *
 * Cria um novo estabelecimento (loja) e a sua conta de acesso.
 *
 * Fluxo:
 *  a) Cria a conta de acesso no Supabase Auth (auth.admin.createUser) com
 *     role 'admin' (o trigger handle_new_user cria o profile).
 *  b) Insere o registro na tabela `establishments` com os dados da loja
 *     (name, owner_name, email, status, user_id).
 *
 * Segurança:
 * - Exige Super Admin (ver lib/supabase/adminGuard.ts).
 * - Se o insert em `establishments` falhar, o usuário auth criado é removido
 *   (rollback) para não deixar conta órfã.
 *
 * Body: { name, owner_name, email, phone?, password, status? }
 */
export async function POST(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode criar estabelecimentos."
  );
  if (!guard.ok) return guard.response;

  // 1) Valida o corpo da requisição.
  let body: {
    name?: string;
    owner_name?: string;
    email?: string;
    phone?: string;
    password?: string;
    status?: string;
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
  const ownerName = body.owner_name?.trim();
  const email = body.email?.trim().toLowerCase();
  const phone = body.phone?.trim() || null;
  const password = body.password;
  const status = body.status ?? "ativo";

  if (!name || !ownerName || !email || !password) {
    return NextResponse.json(
      { error: "Preencha nome da loja, responsável, e-mail e senha." },
      { status: 400 }
    );
  }

  if (!isAllowedStatus(status)) {
    return NextResponse.json({ error: "Status inválido." }, { status: 400 });
  }

  if (password.length < 6) {
    return NextResponse.json(
      { error: "A senha deve ter ao menos 6 caracteres." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // 2a) Cria a conta de acesso no Supabase Auth (role admin).
  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        name: ownerName,
        establishment: name,
        role: "admin",
      },
    });

  if (createError || !created.user) {
    return NextResponse.json(
      { error: createError?.message ?? "Falha ao criar a conta de acesso." },
      { status: 400 }
    );
  }

  const userId = created.user.id;

  // Garante o profile (o trigger já cria; usamos upsert por segurança).
  await adminClient.from("profiles").upsert(
    {
      id: userId,
      name: ownerName,
      email,
      role: "admin",
      establishment: name,
    },
    { onConflict: "id" }
  );

  // 2b) Gera o slug público único (URL amigável do cardápio, ex: `/la-fuego`)
  //     e insere o registro na tabela `establishments`.
  const slug = await generateUniqueSlug(name, async (candidate) => {
    const { data } = await adminClient
      .from("establishments")
      .select("id")
      .eq("slug", candidate)
      .limit(1)
      .maybeSingle();
    return Boolean(data);
  });

  const { data: inserted, error: insertError } = await adminClient
    .from("establishments")
    .insert({
      user_id: userId,
      name,
      owner_name: ownerName,
      email,
      phone,
      status,
      slug,
    })
    .select()
    .single();

  if (insertError || !inserted) {
    // Rollback: remove a conta de acesso criada para não deixar órfã.
    await adminClient.auth.admin.deleteUser(userId);
    return NextResponse.json(
      { error: insertError?.message ?? "Falha ao salvar o estabelecimento." },
      { status: 400 }
    );
  }

  return NextResponse.json({ establishment: inserted }, { status: 201 });
}
