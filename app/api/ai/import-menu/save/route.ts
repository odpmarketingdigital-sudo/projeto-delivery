import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  getOwnedEstablishmentId,
  requireMenuAccess,
} from "@/lib/supabase/menuGuard";
import { sanitizeImportedMenu } from "@/lib/ai/menuImport";

type OrderColumn = "position" | "sort_order";
type AdminClient = ReturnType<typeof createAdminClient>;

/** Detecta erro de "coluna não existe" (Postgres 42703 / PostgREST). */
function isMissingColumnError(
  error: { code?: string | null; message?: string | null } | null,
): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const message = String(error.message ?? "").toLowerCase();
  return (
    message.includes("does not exist") || message.includes("undefined_column")
  );
}

/**
 * Descobre qual coluna de ordenação a base usa: `position` (schema atual) ou
 * `sort_order` (bases legadas) — mesma tolerância de `lib/menuOrder.ts`.
 */
async function resolveOrderColumn(
  adminClient: AdminClient,
  table: "categories" | "products",
  establishmentId: string,
): Promise<OrderColumn> {
  const candidates: OrderColumn[] = ["position", "sort_order"];

  for (const column of candidates) {
    const { error } = await adminClient
      .from(table)
      .select(column)
      .eq("establishment_id", establishmentId)
      .limit(1);

    if (!error) return column;
    if (!isMissingColumnError(error)) {
      throw new Error(error.message);
    }
  }

  throw new Error(
    `A tabela ${table} não possui coluna de ordenação (position/sort_order).`,
  );
}

/** Próxima ordem livre da tabela (maior valor atual + 1). */
async function nextOrderValue(
  adminClient: AdminClient,
  table: "categories" | "products",
  establishmentId: string,
  column: OrderColumn,
): Promise<number> {
  const { data, error } = await adminClient
    .from(table)
    .select(column)
    .eq("establishment_id", establishmentId)
    .order(column, { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);

  const row = Array.isArray(data)
    ? (data[0] as Record<string, unknown> | undefined)
    : undefined;
  const current = Number(row?.[column]);
  return (Number.isFinite(current) && current >= 0 ? current : 0) + 1;
}

/**
 * POST /api/ai/import-menu/save
 *
 * Grava em lote o cardápio revisado no painel. Categorias com o mesmo nome de
 * uma categoria existente são reaproveitadas (evita duplicar "Bebidas"), e os
 * produtos novos sempre apontam para o `establishment_id` autorizado.
 *
 * Body: { establishment_id?, categories: [{ name, products: [...] }] }
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: { establishment_id?: string; categories?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 },
    );
  }

  let establishmentId: string;
  if (guard.isSuperAdmin) {
    establishmentId = body.establishment_id?.trim() ?? "";
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Informe o establishment_id da importação." },
        { status: 400 },
      );
    }
  } else {
    const ownedId = await getOwnedEstablishmentId(guard.user.id);
    if (!ownedId) {
      return NextResponse.json(
        { error: "A sua conta não possui um estabelecimento associado." },
        { status: 403 },
      );
    }
    establishmentId = ownedId;
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    establishmentId,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso ao cardápio deste estabelecimento." },
      { status: 403 },
    );
  }

  const menu = sanitizeImportedMenu({ categories: body.categories });
  if (menu.categories.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nenhum produto válido para salvar. Revise os nomes e os preços antes de enviar.",
      },
      { status: 400 },
    );
  }

  const adminClient = createAdminClient();

  try {
    const [categoryOrderColumn, productOrderColumn] = await Promise.all([
      resolveOrderColumn(adminClient, "categories", establishmentId),
      resolveOrderColumn(adminClient, "products", establishmentId),
    ]);

    let nextCategoryOrder = await nextOrderValue(
      adminClient,
      "categories",
      establishmentId,
      categoryOrderColumn,
    );
    let nextProductOrder = await nextOrderValue(
      adminClient,
      "products",
      establishmentId,
      productOrderColumn,
    );

    // Categorias existentes: reutiliza pelo nome (case-insensitive).
    const { data: existingCategories, error: existingError } = await adminClient
      .from("categories")
      .select("id, name")
      .eq("establishment_id", establishmentId);

    if (existingError) {
      return NextResponse.json(
        { error: existingError.message },
        { status: 400 },
      );
    }

    const categoryIdByKey = new Map<string, string>();
    for (const category of (existingCategories ?? []) as {
      id: string;
      name: string;
    }[]) {
      categoryIdByKey.set(category.name.trim().toLowerCase(), category.id);
    }

    // Só cria as categorias que ainda não existem no cardápio.
    const categoriesToCreate = menu.categories.filter(
      (category) => !categoryIdByKey.has(category.name.trim().toLowerCase()),
    );

    const categoryPayload = categoriesToCreate.map((category) => {
      const payload: Record<string, string | number | boolean> = {
        establishment_id: establishmentId,
        name: category.name,
        is_active: true,
      };
      payload[categoryOrderColumn] = nextCategoryOrder;
      nextCategoryOrder += 1;
      return payload;
    });

    let createdCategoryIds: string[] = [];

    if (categoryPayload.length > 0) {
      const { data: createdCategories, error: createError } = await adminClient
        .from("categories")
        .insert(categoryPayload)
        .select("id, name");

      if (createError || !createdCategories) {
        return NextResponse.json(
          { error: createError?.message ?? "Falha ao criar as categorias." },
          { status: 400 },
        );
      }

      const created = createdCategories as { id: string; name: string }[];
      createdCategoryIds = created.map((category) => category.id);
      for (const category of created) {
        categoryIdByKey.set(category.name.trim().toLowerCase(), category.id);
      }
    }

    const productPayload: Record<string, string | number | boolean | null>[] =
      [];
    for (const category of menu.categories) {
      const categoryId =
        categoryIdByKey.get(category.name.trim().toLowerCase()) ?? null;

      for (const product of category.products) {
        productPayload.push({
          establishment_id: establishmentId,
          category_id: categoryId,
          name: product.name,
          description: product.description,
          price: product.price,
          image_url: "",
          is_active: true,
          [productOrderColumn]: nextProductOrder,
        });
        nextProductOrder += 1;
      }
    }

    const { error: productsError } = await adminClient
      .from("products")
      .insert(productPayload);

    if (productsError) {
      // Rollback manual: remove apenas as categorias criadas nesta chamada,
      // para não deixar seções vazias no cardápio.
      if (createdCategoryIds.length > 0) {
        await adminClient
          .from("categories")
          .delete()
          .in("id", createdCategoryIds);
      }
      return NextResponse.json(
        { error: productsError.message ?? "Falha ao salvar os produtos." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        created: {
          categories: createdCategoryIds.length,
          products: productPayload.length,
        },
        establishment_id: establishmentId,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[ai/import-menu/save] erro inesperado:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Erro inesperado ao salvar o cardápio importado.",
      },
      { status: 500 },
    );
  }
}

