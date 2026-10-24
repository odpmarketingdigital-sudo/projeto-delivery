import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { deleteProductImageFromStorage } from "@/lib/supabase/storage";
import {
  requireMenuAccess,
  canManageEstablishment,
  getOwnedEstablishmentId,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import type { Category, MenuAddon, MenuData, MenuProduct } from "@/lib/types";

/** Linha crua de `products` como vem do PostgREST (price pode ser string). */
type ProductRow = Omit<MenuProduct, "price" | "category_name"> & {
  price: number | string;
  sort_order?: number | null;
  /** Join opcional: `categories ( name )` quando usado no select. */
  categories?: { name?: string | null } | null;
};

/** Normaliza uma linha do banco para o tipo `MenuProduct` (price → number). */
function mapProduct(row: ProductRow): MenuProduct {
  const { categories, ...rest } = row;
  return {
    ...rest,
    category_name: categories?.name ?? null,
    price: Number(row.price) || 0,
  };
}

/**
 * Próxima ordem de ordenação (maior valor atual + 1).
 */
async function nextSortOrder(establishmentId: string): Promise<number> {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from("products")
    .select("sort_order")
    .eq("establishment_id", establishmentId)
    .order("sort_order", { ascending: false })
    .limit(1);

  const row = Array.isArray(data) ? data[0] : undefined;
  return (row?.sort_order ?? 0) + 1;
}

/**
 * GET /api/products?establishment_id=xxx
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
      { error: "Você não tem acesso ao cardápio deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();

  const fetchProducts = async (withJoin: boolean) =>
    adminClient
      .from("products")
      .select(withJoin ? "*, categories ( name )" : "*")
      .eq("establishment_id", establishmentId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

  const [categoriesRes, addonsRes] = await Promise.all([
    adminClient
      .from("categories")
      .select("*")
      .eq("establishment_id", establishmentId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    adminClient
      .from("addons")
      .select("*")
      .eq("establishment_id", establishmentId)
      .order("name", { ascending: true }),
  ]);

  let productsRes = await fetchProducts(true);
  if (productsRes.error) {
    const message = String(productsRes.error.message ?? "").toLowerCase();
    const isJoinError =
      message.includes("categories") &&
      (message.includes("relationship") ||
        message.includes("foreign") ||
        message.includes("could not find") ||
        message.includes("does not exist"));
    if (isJoinError) productsRes = await fetchProducts(false);
  }

  if (categoriesRes.error || productsRes.error) {
    return NextResponse.json(
      {
        error:
          categoriesRes.error?.message ??
          productsRes.error?.message ??
          "Falha ao carregar o cardápio. Verifique se as tabelas existem.",
      },
      { status: 400 }
    );
  }

  const categories = (categoriesRes.data as Category[]) ?? [];
  const categoryNameById = new Map(
    categories.map((category) => [category.id, category.name])
  );
  // `as unknown as` é necessário porque, sem os tipos gerados do Supabase, o
  // parser não resolve o join `categories ( name )` e infere `ParserError[]`.
  const products = (
    (productsRes.data as unknown as ProductRow[]) ?? []
  ).map((row) => {
    const mapped = mapProduct(row);
    if (!mapped.category_name && mapped.category_id) {
      mapped.category_name =
        categoryNameById.get(mapped.category_id) ?? null;
    }
    return mapped;
  });

  const payload: MenuData = {
    categories,
    products,
    addons: (addonsRes.data as MenuAddon[]) ?? [],
  };

  return NextResponse.json(payload, { status: 200 });
}

/**
 * POST /api/products
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    establishment_id?: string;
    category_id?: string | null;
    name?: string;
    description?: string;
    price?: number | string;
    image_url?: string;
    is_active?: boolean;
    track_stock?: boolean;
    stock_quantity?: number | string;
    sort_order?: number | string;
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
        { error: "Informe o establishment_id do produto." },
        { status: 400 }
      );
    }
  } else {
    establishmentId = await getOwnedEstablishmentId(guard.user.id);
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Sua conta não possui um estabelecimento associado." },
        { status: 403 }
      );
    }
  }

  const name = body.name?.trim();
  const price = Number(body.price);

  if (!name) {
    return NextResponse.json(
      { error: "Informe o nome do produto." },
      { status: 400 }
    );
  }
  if (!Number.isFinite(price) || price < 0) {
    return NextResponse.json(
      { error: "Informe um preço válido (maior ou igual a zero)." },
      { status: 400 }
    );
  }

  // Estoque: quando o controle está desativado, o produto é ilimitado e a
  // quantidade persistida é zerada.
  const trackStock = body.track_stock === true;
  const stockQuantity = Number(body.stock_quantity ?? 0);
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
    return NextResponse.json(
      {
        error:
          "Informe uma quantidade em estoque válida (inteiro maior ou igual a zero).",
      },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const categoryId = body.category_id?.trim() || null;
  if (categoryId) {
    const { data: category, error: categoryError } = await adminClient
      .from("categories")
      .select("establishment_id")
      .eq("id", categoryId)
      .maybeSingle();
    if (categoryError) {
      return NextResponse.json(
        { error: categoryError.message ?? "Falha ao validar a categoria." },
        { status: 400 }
      );
    }
    if (!category) {
      return NextResponse.json(
        { error: "Categoria não encontrada." },
        { status: 404 }
      );
    }
    if (category.establishment_id !== establishmentId) {
      return NextResponse.json(
        { error: "A categoria informada não pertence a este estabelecimento." },
        { status: 400 }
      );
    }
  }

  const explicitOrder =
    body.sort_order !== undefined ? Number(body.sort_order) : NaN;
  const sort_order = Number.isFinite(explicitOrder)
    ? explicitOrder
    : await nextSortOrder(establishmentId);

  const { data: created, error } = await adminClient
    .from("products")
    .insert({
      establishment_id: establishmentId,
      category_id: categoryId,
      name,
      description: body.description?.trim() ?? "",
      price,
      image_url: body.image_url?.trim() ?? "",
      is_active: body.is_active ?? true,
      track_stock: trackStock,
      stock_quantity: trackStock ? stockQuantity : 0,
      sort_order,
    })
    .select("*, categories ( name )")
    .single();

  if (error || !created) {
    return NextResponse.json(
      { error: error?.message ?? "Falha ao criar o produto." },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { product: mapProduct(created as ProductRow) },
    { status: 201 }
  );
}

/**
 * PUT /api/products
 */
export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    id?: string;
    name?: string;
    category_id?: string | null;
    description?: string;
    price?: number | string;
    image_url?: string;
    is_active?: boolean;
    track_stock?: boolean;
    stock_quantity?: number | string;
    sort_order?: number | string;
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
      { error: "Informe o id do produto." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("products")
    .select("establishment_id, image_url")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o produto." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Produto não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode editar produtos deste estabelecimento." },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json(
        { error: "O nome do produto não pode ficar vazio." },
        { status: 400 }
      );
    }
    patch.name = name;
  }
  if (body.category_id !== undefined) {
    const nextCategoryId = body.category_id?.trim() || null;
    if (nextCategoryId) {
      const { data: category, error: categoryError } = await adminClient
        .from("categories")
        .select("establishment_id")
        .eq("id", nextCategoryId)
        .maybeSingle();
      if (categoryError) {
        return NextResponse.json(
          { error: categoryError.message ?? "Falha ao validar a categoria." },
          { status: 400 }
        );
      }
      if (!category) {
        return NextResponse.json(
          { error: "Categoria não encontrada." },
          { status: 404 }
        );
      }
      if (category.establishment_id !== existing.establishment_id) {
        return NextResponse.json(
          {
            error: "A categoria informada não pertence a este estabelecimento.",
          },
          { status: 400 }
        );
      }
    }
    patch.category_id = nextCategoryId;
  }
  if (body.description !== undefined) {
    patch.description = body.description.trim();
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
  if (body.image_url !== undefined) {
    patch.image_url = body.image_url.trim();
  }
  if (body.is_active !== undefined) {
    patch.is_active = Boolean(body.is_active);
  }
  if (body.track_stock !== undefined) {
    patch.track_stock = Boolean(body.track_stock);
  }
  if (body.stock_quantity !== undefined) {
    const stockQuantity = Number(body.stock_quantity);
    if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
      return NextResponse.json(
        {
          error:
            "Informe uma quantidade em estoque válida (inteiro maior ou igual a zero).",
        },
        { status: 400 }
      );
    }
    patch.stock_quantity = stockQuantity;
  }
  // Desativar o controle de estoque zera a quantidade (estoque ilimitado).
  if (patch.track_stock === false) {
    patch.stock_quantity = 0;
  }
  if (body.sort_order !== undefined) {
    const order = Number(body.sort_order);
    if (!Number.isFinite(order)) {
      return NextResponse.json(
        { error: "Informe uma ordenação válida para o produto." },
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
    .from("products")
    .update(patch)
    .eq("id", id)
    .select("*, categories ( name )")
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: updateError?.message ?? "Falha ao atualizar o produto." },
      { status: 400 }
    );
  }

  // Se a imagem foi alterada, remove a antiga do bucket para evitar órfãos.
  const newImageUrl = body.image_url?.trim();
  const oldImageUrl = existing.image_url ?? undefined;
  if (newImageUrl !== undefined && newImageUrl !== oldImageUrl) {
    await deleteProductImageFromStorage(oldImageUrl);
  }

  return NextResponse.json(
    { product: mapProduct(updated as ProductRow) },
    { status: 200 }
  );
}

/**
 * DELETE /api/products
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
      { error: "Informe o id do produto." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("products")
    .select("establishment_id, image_url")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o produto." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Produto não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode excluir produtos deste estabelecimento." },
      { status: 403 }
    );
  }

  // 1. Remove a imagem do bucket `products` (evita arquivos órfãos).
  await deleteProductImageFromStorage(existing.image_url ?? undefined);

  // 2. Remove o registro do banco de dados.
  const { error: deleteError } = await adminClient
    .from("products")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message ?? "Falha ao excluir o produto." },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}