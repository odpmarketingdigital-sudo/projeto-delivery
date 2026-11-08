import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  requireMenuAccess,
  canManageEstablishment,
  getOwnedEstablishmentId,
} from "@/lib/supabase/menuGuard";
import type { MenuAddonGroup } from "@/lib/types";
import { fetchWithOrderFallback, getOrderValue } from "@/lib/menuOrder";

/**
 * GET /api/addon-groups?establishment_id=xxx&product_id=yyy
 *
 * Lista os grupos de opcionais do estabelecimento (e, opcionalmente, de um
 * produto), ordenados por `position`.
 *
 * Segurança: exige sessão; o requisitante só acessa o próprio estabelecimento
 * (admin) ou qualquer um (super_admin) — ver `canManageEstablishment`.
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const params = new URL(request.url).searchParams;
  const establishmentId = params.get("establishment_id")?.trim();
  const productId = params.get("product_id")?.trim() || null;

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
      { error: "Você não tem acesso aos grupos deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await fetchWithOrderFallback<MenuAddonGroup>((col) => {
    let query = adminClient
      .from("addon_groups")
      .select("*")
      .eq("establishment_id", establishmentId);
    if (productId) query = query.eq("product_id", productId);
    return query
      .order(col, { ascending: true })
      .order("name", { ascending: true });
  });

  if (error) {
    return NextResponse.json(
      {
        error:
          error.message ??
          "Falha ao carregar os grupos. Verifique se a tabela addon_groups existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ addon_groups: data ?? [] }, { status: 200 });
}

/**
 * Próxima posição de ordenação do grupo (maior valor atual + 1) dentro do
 * produto. Resiliente: position → sort_order → 0 — nunca quebra.
 */
async function nextGroupPosition(
  establishmentId: string,
  productId: string
): Promise<number> {
  const adminClient = createAdminClient();
  const { data } = await fetchWithOrderFallback<{
    position?: number | null;
    sort_order?: number | null;
  }>((col) =>
    adminClient
      .from("addon_groups")
      .select("position, sort_order")
      .eq("establishment_id", establishmentId)
      .eq("product_id", productId)
      .order(col, { ascending: false })
      .limit(1)
  );
  const row = Array.isArray(data) ? data[0] : undefined;
  return getOrderValue(row ?? {}) + 1;
}

/** Normaliza/valida a regra de seleção (min/max) de um grupo. */
function sanitizeSelectors(
  minRaw: unknown,
  maxRaw: unknown,
  isRequired: boolean
): { min: number; max: number } | null {
  const min = Math.floor(Number(minRaw));
  const max = Math.floor(Number(maxRaw));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min < 0 || max < 1) return null;
  // Grupo obrigatório exige ao menos 1 escolha.
  const finalMin = isRequired ? Math.max(1, min) : min;
  if (finalMin > max) return null;
  return { min: finalMin, max };
}

/**
 * POST /api/addon-groups
 *
 * Cria um grupo de opcionais para um produto. A `position` é calculada
 * automaticamente (fim da lista do produto).
 *
 * Segurança:
 *  - `admin`: o `establishment_id` é resolvido da sessão (ignora o corpo).
 *  - `super_admin`: usa o `establishment_id` enviado no corpo (obrigatório).
 *  - O `product_id` informado é validado contra o estabelecimento alvo.
 *
 * Body: { establishment_id?, product_id, name, description?, is_required?,
 *         min_selectors?, max_selectors? }
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    establishment_id?: string;
    product_id?: string;
    name?: string;
    description?: string;
    is_required?: boolean;
    min_selectors?: number;
    max_selectors?: number;
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
        { error: "Informe o establishment_id do grupo." },
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

  const productId = body.product_id?.trim();
  const name = body.name?.trim();
  const description = body.description?.trim() ?? "";
  const isRequired = body.is_required === true;

  if (!productId) {
    return NextResponse.json(
      { error: "Informe o product_id do grupo." },
      { status: 400 }
    );
  }
  if (!name) {
    return NextResponse.json(
      { error: "Informe o nome do grupo." },
      { status: 400 }
    );
  }

  const selectors = sanitizeSelectors(
    body.min_selectors ?? (isRequired ? 1 : 0),
    body.max_selectors ?? 1,
    isRequired
  );
  if (!selectors) {
    return NextResponse.json(
      {
        error:
          "Regra de seleção inválida. Use mín. ≥ 0, máx. ≥ 1 e mín. ≤ máx.",
      },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // Valida que o produto existe e pertence ao estabelecimento alvo.
  const { data: product, error: productError } = await adminClient
    .from("products")
    .select("id, establishment_id")
    .eq("id", productId)
    .maybeSingle();

  if (productError) {
    return NextResponse.json(
      { error: productError.message ?? "Falha ao localizar o produto." },
      { status: 400 }
    );
  }
  if (!product) {
    return NextResponse.json({ error: "Produto não encontrado." }, { status: 404 });
  }
  if (product.establishment_id !== establishmentId) {
    return NextResponse.json(
      { error: "O produto informado não pertence a este estabelecimento." },
      { status: 403 }
    );
  }

  const position = await nextGroupPosition(establishmentId, productId);

  const { data: created, error } = await adminClient
    .from("addon_groups")
    .insert({
      establishment_id: establishmentId,
      product_id: productId,
      name,
      description,
      is_required: isRequired,
      min_selectors: selectors.min,
      max_selectors: selectors.max,
      is_active: true,
      position,
    })
    .select()
    .single();

  if (error || !created) {
    return NextResponse.json(
      {
        error:
          error?.message ??
          "Falha ao criar o grupo. Verifique se a tabela addon_groups existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { addon_group: created as MenuAddonGroup },
    { status: 201 }
  );
}

/**
 * PUT /api/addon-groups
 *
 * Atualiza um grupo (nome, descrição, obrigatoriedade, min/max, status e/ou
 * posição).
 *
 * Segurança: só quem gerencia o estabelecimento dono do grupo pode editá-lo.
 *
 * Body: { id, name?, description?, is_required?, min_selectors?,
 *         max_selectors?, is_active?, position? }
 */
export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    id?: string;
    name?: string;
    description?: string;
    is_required?: boolean;
    min_selectors?: number;
    max_selectors?: number;
    is_active?: boolean;
    position?: number;
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
  if (!id) {
    return NextResponse.json(
      { error: "Informe o id do grupo." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("addon_groups")
    .select("establishment_id, is_required, min_selectors, max_selectors")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o grupo." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Grupo não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode editar grupos deste estabelecimento." },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { error: "O nome do grupo não pode ficar vazio." },
        { status: 400 }
      );
    }
    patch.name = name;
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === "string" ? body.description : "";
  }

  // Recalcula min/max quando qualquer regra muda (parte do estado atual).
  const nextRequired =
    body.is_required !== undefined
      ? Boolean(body.is_required)
      : Boolean(existing.is_required);
  if (
    body.min_selectors !== undefined ||
    body.max_selectors !== undefined ||
    body.is_required !== undefined
  ) {
    const selectors = sanitizeSelectors(
      body.min_selectors !== undefined ? body.min_selectors : existing.min_selectors,
      body.max_selectors !== undefined ? body.max_selectors : existing.max_selectors,
      nextRequired
    );
    if (!selectors) {
      return NextResponse.json(
        {
          error:
            "Regra de seleção inválida. Use mín. ≥ 0, máx. ≥ 1 e mín. ≤ máx.",
        },
        { status: 400 }
      );
    }
    patch.min_selectors = selectors.min;
    patch.max_selectors = selectors.max;
  }
  if (body.is_required !== undefined) {
    patch.is_required = nextRequired;
  }
  if (body.is_active !== undefined) {
    patch.is_active = Boolean(body.is_active);
  }
  if (body.position !== undefined) {
    patch.position = Number(body.position);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "Nenhum campo para atualizar." },
      { status: 400 }
    );
  }

  const { data: updated, error: updateError } = await adminClient
    .from("addon_groups")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: updateError?.message ?? "Falha ao atualizar o grupo." },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { addon_group: updated as MenuAddonGroup },
    { status: 200 }
  );
}

/**
 * DELETE /api/addon-groups
 *
 * Exclui um grupo. Os itens (addons) do grupo NÃO são apagados — o `group_id`
 * deles passa a null (ficam "sem grupo"), graças ao ON DELETE SET NULL.
 *
 * Segurança: só quem gerencia o estabelecimento dono do grupo pode excluí-lo.
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
      { error: "Informe o id do grupo." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("addon_groups")
    .select("establishment_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o grupo." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Grupo não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode excluir grupos deste estabelecimento." },
      { status: 403 }
    );
  }

  const { error: deleteError } = await adminClient
    .from("addon_groups")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message ?? "Falha ao excluir o grupo." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}



