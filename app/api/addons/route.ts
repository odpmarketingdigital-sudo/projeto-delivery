import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  requireMenuAccess,
  canManageEstablishment,
  getOwnedEstablishmentId,
} from "@/lib/supabase/menuGuard";
import type { MenuAddon } from "@/lib/types";
import { fetchWithOrderFallback, getOrderValue } from "@/lib/menuOrder";

/** Linha crua de `addons` como vem do PostgREST (price pode ser string). */
type AddonRow = Omit<MenuAddon, "price"> & { price: number | string };

/** Normaliza uma linha do banco para o tipo `MenuAddon` (price → number). */
function mapAddon(row: AddonRow): MenuAddon {
  return {
    ...row,
    price: Number(row.price) || 0,
    is_required: Boolean(row.is_required),
  };
}

/**
 * Próxima posição de ordenação do adicional (maior valor atual + 1) dentro do
 * produto. Resiliente: position → sort_order → 0 — nunca quebra.
 */
async function nextAddonPosition(
  establishmentId: string,
  productId: string
): Promise<number> {
  const adminClient = createAdminClient();
  const { data } = await fetchWithOrderFallback<{
    position?: number | null;
    sort_order?: number | null;
  }>((col) =>
    adminClient
      .from("addons")
      .select("position, sort_order")
      .eq("establishment_id", establishmentId)
      .eq("product_id", productId)
      .order(col, { ascending: false })
      .limit(1)
  );
  const row = Array.isArray(data) ? data[0] : undefined;
  return getOrderValue(row ?? {}) + 1;
}

/**
 * GET /api/addons?establishment_id=xxx&product_id=yyy
 *
 * Lista os adicionais do estabelecimento (e, opcionalmente, de um produto),
 * ordenados por `position`.
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
      { error: "Você não tem acesso aos adicionais deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await fetchWithOrderFallback<AddonRow>((col) => {
    let query = adminClient
      .from("addons")
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
          "Falha ao carregar os adicionais. Verifique se a tabela addons existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { addons: (data ?? []).map(mapAddon) },
    { status: 200 }
  );
}

/**
 * POST /api/addons
 *
 * Cria um adicional para um produto. A `position` é calculada automaticamente
 * (fim da lista do produto).
 *
 * Segurança:
 *  - `admin`: o `establishment_id` é resolvido da sessão (ignora o corpo).
 *  - `super_admin`: usa o `establishment_id` enviado no corpo (obrigatório).
 *  - O `product_id` informado é validado contra o estabelecimento alvo.
 *
 * Body: { establishment_id?, product_id, name, price, is_required?, is_active? }
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    establishment_id?: string;
    product_id?: string;
    name?: string;
    price?: number | string;
    is_required?: boolean;
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

  // Resolve o estabelecimento alvo conforme o papel do requisitante.
  let establishmentId: string | null;
  if (guard.isSuperAdmin) {
    establishmentId = body.establishment_id?.trim() ?? null;
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Informe o establishment_id do adicional." },
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
  const price = Number(body.price);

  if (!productId) {
    return NextResponse.json(
      { error: "Informe o product_id do adicional." },
      { status: 400 }
    );
  }
  if (!name) {
    return NextResponse.json(
      { error: "Informe o nome do adicional." },
      { status: 400 }
    );
  }
  if (!Number.isFinite(price) || price < 0) {
    return NextResponse.json(
      { error: "Informe um preço válido (maior ou igual a zero)." },
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

  const position = await nextAddonPosition(establishmentId, productId);

  const { data: created, error } = await adminClient
    .from("addons")
    .insert({
      establishment_id: establishmentId,
      product_id: productId,
      name,
      price,
      is_required: body.is_required ?? false,
      is_active: body.is_active ?? true,
      position,
    })
    .select()
    .single();

  if (error || !created) {
    return NextResponse.json(
      {
        error:
          error?.message ??
          "Falha ao criar o adicional. Verifique se a tabela addons existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { addon: mapAddon(created as AddonRow) },
    { status: 201 }
  );
}

/**
 * PUT /api/addons
 *
 * Atualiza um adicional (nome, preço, status `is_active` e/ou posição).
 *
 * Segurança: só quem gerencia o estabelecimento dono do adicional pode editá-lo.
 *
 * Body: { id, name?, price?, is_required?, is_active?, position? }
 */
export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    id?: string;
    name?: string;
    price?: number | string;
    is_required?: boolean;
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
      { error: "Informe o id do adicional." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("addons")
    .select("establishment_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o adicional." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Adicional não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode editar adicionais deste estabelecimento." },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { error: "O nome do adicional não pode ficar vazio." },
        { status: 400 }
      );
    }
    patch.name = name;
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) {
      return NextResponse.json(
        { error: "Informe um preço válido (maior ou igual a zero)." },
        { status: 400 }
      );
    }
    patch.price = price;
  }
  if (body.is_required !== undefined) {
    patch.is_required = Boolean(body.is_required);
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
    .from("addons")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: updateError?.message ?? "Falha ao atualizar o adicional." },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { addon: mapAddon(updated as AddonRow) },
    { status: 200 }
  );
}

/**
 * DELETE /api/addons
 *
 * Exclui um adicional.
 *
 * Segurança: só quem gerencia o estabelecimento dono do adicional pode excluí-lo.
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
      { error: "Informe o id do adicional." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("addons")
    .select("establishment_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o adicional." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Adicional não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode excluir adicionais deste estabelecimento." },
      { status: 403 }
    );
  }

  const { error: deleteError } = await adminClient
    .from("addons")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message ?? "Falha ao excluir o adicional." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}

