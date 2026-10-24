import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  requireMenuAccess,
  canManageEstablishment,
  getOwnedEstablishmentId,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import type { Category } from "@/lib/types";

/** Linha crua de `categories` como vem do PostgREST. */
type CategoryRow = Category;

/**
 * GET /api/categories?establishment_id=xxx
 * Lista as categorias do estabelecimento, ordenadas por `sort_order`.
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const requestedId = new URL(request.url).searchParams.get(
    "establishment_id"
  );

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    requestedId
  );
  if ("response" in resolved) return resolved.response;
  const establishmentId = resolved.id;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    establishmentId
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Não tem acesso às categorias deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("categories")
    .select("*")
    .eq("establishment_id", establishmentId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json(
      {
        error:
          error.message ??
          "Falha ao carregar as categorias. Verifique se a tabela existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { categories: (data as CategoryRow[]) ?? [] },
    { status: 200 }
  );
}

/**
 * POST /api/categories
 * Cria uma nova categoria no cardápio do estabelecimento.
 * Body: { establishment_id?, name, sort_order?, is_active? }
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    establishment_id?: string;
    name?: string;
    sort_order?: number | string;
    is_active?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  let establishmentId: string | null;
  if (guard.isSuperAdmin) {
    establishmentId = body.establishment_id?.trim() ?? null;
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Informe o establishment_id da categoria." },
        { status: 400 }
      );
    }
  } else {
    establishmentId = await getOwnedEstablishmentId(guard.user.id);
    if (!establishmentId) {
      return NextResponse.json(
        { error: "A sua conta não possui um estabelecimento associado." },
        { status: 403 }
      );
    }
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json(
      { error: "Informe o nome da categoria." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // Próxima ordem (maior atual + 1).
  const { data: last } = await adminClient
    .from("categories")
    .select("sort_order")
    .eq("establishment_id", establishmentId)
    .order("sort_order", { ascending: false })
    .limit(1);

  const lastRow = Array.isArray(last) ? last[0] : undefined;
  const explicitOrder =
    body.sort_order !== undefined ? Number(body.sort_order) : NaN;
  const sort_order = Number.isFinite(explicitOrder)
    ? explicitOrder
    : (lastRow?.sort_order ?? 0) + 1;

  const { data: created, error } = await adminClient
    .from("categories")
    .insert({
      establishment_id: establishmentId,
      name,
      sort_order,
      is_active: body.is_active ?? true,
    })
    .select()
    .single();

  if (error || !created) {
    return NextResponse.json(
      { error: error?.message ?? "Falha ao criar a categoria." },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { category: created as CategoryRow },
    { status: 201 }
  );
}

/**
 * PUT /api/categories
 * Atualiza uma categoria ou reordena em lote.
 */
export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    id?: string;
    name?: string;
    is_active?: boolean;
    sort_order?: number | string;
    order?: { id: string; sort_order?: number; position?: number }[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // --- Reordenação em lote ------------------------------------------------
  if (Array.isArray(body.order)) {
    const order = body.order.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        Number.isFinite(Number(item.sort_order ?? item.position))
    );
    if (order.length === 0) {
      return NextResponse.json(
        { error: "Lista de ordenação vazia ou inválida." },
        { status: 400 }
      );
    }

    const { data: first } = await adminClient
      .from("categories")
      .select("establishment_id")
      .eq("id", order[0].id)
      .maybeSingle();
    if (!first) {
      return NextResponse.json(
        { error: "Categoria não encontrada." },
        { status: 404 }
      );
    }
    const allowed = await canManageEstablishment(
      guard.user.id,
      guard.isSuperAdmin,
      first.establishment_id
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "Não pode reordenar categorias deste estabelecimento." },
        { status: 403 }
      );
    }

    for (const item of order) {
      const val = Number(item.sort_order ?? item.position);
      const { error } = await adminClient
        .from("categories")
        .update({ sort_order: val })
        .eq("id", item.id);
      if (error) {
        return NextResponse.json(
          { error: error.message ?? "Falha ao reordenar categorias." },
          { status: 400 }
        );
      }
    }

    return NextResponse.json({ success: true }, { status: 200 });
  }

  // --- Atualização simples de uma categoria -------------------------------
  const id = body.id?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "Informe o id da categoria." },
      { status: 400 }
    );
  }

  const { data: existing, error: findError } = await adminClient
    .from("categories")
    .select("establishment_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar a categoria." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json(
      { error: "Categoria não encontrada." },
      { status: 404 }
    );
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Não pode editar categorias deste estabelecimento." },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { error: "O nome da categoria não pode ficar vazio." },
        { status: 400 }
      );
    }
    patch.name = name;
  }
  if (body.is_active !== undefined) {
    patch.is_active = Boolean(body.is_active);
  }
  if (body.sort_order !== undefined) {
    const order = Number(body.sort_order);
    if (!Number.isFinite(order)) {
      return NextResponse.json(
        { error: "Informe uma ordenação válida para a categoria." },
        { status: 400 }
      );
    }
    patch.sort_order = order;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "Nenhum campo para atualizar." },
      { status: 400 }
    );
  }

  const { data: updated, error: updateError } = await adminClient
    .from("categories")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: updateError?.message ?? "Falha ao atualizar a categoria." },
      { status: 400 }
    );
  }

  return NextResponse.json({ category: updated as CategoryRow }, { status: 200 });
}

/**
 * DELETE /api/categories?id=xxx
 * Exclui uma categoria.
 */
export async function DELETE(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) {
    try {
      const body = (await request.json()) as { id?: string };
      id = body.id?.trim();
    } catch {
      // Ignora erro se não houver corpo
    }
  }

  if (!id) {
    return NextResponse.json(
      { error: "Informe o id da categoria." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("categories")
    .select("establishment_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar a categoria." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json(
      { error: "Categoria não encontrada." },
      { status: 404 }
    );
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Não pode excluir categorias deste estabelecimento." },
      { status: 403 }
    );
  }

  const { error: deleteError } = await adminClient
    .from("categories")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message ?? "Falha ao excluir a categoria." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}