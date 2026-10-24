import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  requireMenuAccess,
  canManageEstablishment,
  getOwnedEstablishmentId,
} from "@/lib/supabase/menuGuard";

/**
 * GET /api/customers?establishment_id=xxx
 *
 * Lista os clientes do estabelecimento (ordenados pelos mais recentes).
 *
 * Segurança: exige sessão; o requisitante só acessa o próprio estabelecimento
 * (admin) ou qualquer um (super_admin) — ver `canManageEstablishment`.
 *
 * Colunas esperadas em `public.customers`:
 *   id, establishment_id, name, phone?, email?, address?, created_at, updated_at.
 * A listagem usa `select("*")` para tolerar variações do schema padronizado.
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const establishmentId = new URL(request.url).searchParams
    .get("establishment_id")
    ?.trim();

  if (!establishmentId) {
    return NextResponse.json(
      { error: "Parâmetro establishment_id é obrigatório." },
      { status: 400 }
    );
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    establishmentId
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso aos clientes deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("customers")
    .select("*")
    .eq("establishment_id", establishmentId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      {
        error:
          error.message ??
          "Falha ao carregar os clientes. Verifique se a tabela customers existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ customers: data ?? [] }, { status: 200 });
}

/**
 * POST /api/customers
 *
 * Cria um cliente para o estabelecimento.
 *
 * Segurança:
 *  - `admin`: o `establishment_id` é resolvido da sessão (ignora o corpo).
 *  - `super_admin`: usa o `establishment_id` enviado no corpo (obrigatório).
 *
 * Body: { establishment_id?, name, phone?, email?, address? }
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    establishment_id?: string;
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  // Resolve o estabelecimento alvo conforme o papel do requisitante.
  let establishmentId: string | null;
  if (guard.isSuperAdmin) {
    establishmentId = body.establishment_id?.trim() ?? null;
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Informe o establishment_id do cliente." },
        { status: 400 }
      );
    }
  } else {
    // Admin: sempre o próprio estabelecimento (nunca confia no corpo).
    establishmentId = await getOwnedEstablishmentId(guard.user.id);
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Sua conta não possui um estabelecimento associado." },
        { status: 403 }
      );
    }
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json(
      { error: "Informe o nome do cliente." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();
  const { data: created, error } = await adminClient
    .from("customers")
    .insert({
      establishment_id: establishmentId,
      name,
      phone: body.phone?.trim() || null,
      email: body.email?.trim() || null,
      address: body.address?.trim() || null,
    })
    .select()
    .single();

  if (error || !created) {
    return NextResponse.json(
      {
        error:
          error?.message ??
          "Falha ao criar o cliente. Verifique se a tabela customers existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ customer: created }, { status: 201 });
}

/**
 * DELETE /api/customers
 *
 * Exclui um cliente.
 *
 * Segurança: só quem gerencia o estabelecimento dono do cliente pode excluí-lo.
 *
 * Body: { id }
 */
export async function DELETE(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

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
      { error: "Informe o id do cliente." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("customers")
    .select("establishment_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o cliente." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Cliente não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode excluir clientes deste estabelecimento." },
      { status: 403 }
    );
  }

  const { error: deleteError } = await adminClient
    .from("customers")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message ?? "Falha ao excluir o cliente." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}
