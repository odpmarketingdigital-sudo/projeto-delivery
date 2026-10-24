import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { fetchWithOrderFallback } from "@/lib/menuOrder";
import { normalizeOpeningHours } from "@/lib/openingHours";
import { normalizeDeliverySettings } from "@/lib/delivery";
import type {
  Category,
  MenuAddon,
  MenuProduct,
  StorefrontInfo,
  StorefrontMenu,
} from "@/lib/types";

/**
 * GET /api/menu?slug=xxx  |  ?establishment_id=xxx  |  (sem parâmetro)
 *
 * Cardápio PÚBLICO da vitrine (`/demo` e `/[slug]`) e do checkout — não exige
 * sessão. Usa o cliente service role (bypass de RLS) e devolve APENAS lojas
 * `status = 'ativo'` e itens `is_active = true`.
 *
 * Sem parâmetro, resolve a primeira loja ativa (ordem: `created_at`), o que
 * mantém o comportamento da vitrine demonstrativa de página única.
 *
 * A ordenação usa `fetchWithOrderFallback` porque o schema pode trazer a
 * coluna de ordem como `position` (migrations) ou `sort_order` (bases legadas).
 */

/** Linha crua de `establishments` (colunas novas podem vir null/ausentes). */
type EstablishmentRow = Partial<StorefrontInfo> & {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  delivery_fee?: number | string | null;
};

/** Linha crua de `products` (price pode vir string). */
type ProductRow = Omit<MenuProduct, "price" | "category_name"> & {
  price: number | string;
  categories?: { name?: string | null } | null;
};

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Normaliza uma linha de `establishments` para `StorefrontInfo`. */
function mapEstablishment(row: EstablishmentRow): StorefrontInfo {
  const delivery = normalizeDeliverySettings(row as unknown);
  return {
    id: String(row.id ?? ""),
    slug: typeof row.slug === "string" && row.slug ? row.slug : null,
    name: row.name?.trim() || "Estabelecimento",
    description:
      typeof row.description === "string" && row.description
        ? row.description
        : null,
    banner_url:
      typeof row.banner_url === "string" && row.banner_url
        ? row.banner_url
        : null,
    logo_url:
      typeof row.logo_url === "string" && row.logo_url ? row.logo_url : null,
    whatsapp:
      typeof row.whatsapp === "string" && row.whatsapp ? row.whatsapp : null,
    phone: typeof row.phone === "string" && row.phone ? row.phone : null,
    delivery_fee: delivery.delivery_fee,
    delivery_type: delivery.delivery_type,
    distance_base_km: delivery.distance_base_km,
    distance_base_fee: delivery.distance_base_fee,
    distance_extra_km_fee: delivery.distance_extra_km_fee,
    max_delivery_radius_km: delivery.max_delivery_radius_km,
    estimated_delivery_time_min: delivery.estimated_delivery_time_min,
    estimated_delivery_time_max: delivery.estimated_delivery_time_max,
    opening_hours: normalizeOpeningHours(row.opening_hours),
  };
}

/** Normaliza uma linha de `products` para `MenuProduct` (price → number). */
function mapProduct(row: ProductRow): MenuProduct {
  const { categories, ...rest } = row;
  return {
    ...rest,
    category_name: categories?.name ?? null,
    price: toNumber(row.price),
  };
}

/** Responde com erro JSON padronizado. */
function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requestedId = params.get("establishment_id")?.trim() || null;
  const requestedSlug = params.get("slug")?.trim() || null;

  if (requestedId && requestedSlug) {
    return errorResponse(
      "Informe apenas um identificador: establishment_id OU slug.",
      400
    );
  }

  const adminClient = createAdminClient();

  // 1) Resolve a loja alvo (id → slug → primeira ativa).
  // NOTA: `delivery_fee` pode não existir em bases legadas — por isso o
  // select usa `*` (tolerante) e `mapEstablishment` aplica fallback `?? 0`.
  let establishmentQuery = adminClient
    .from("establishments")
    .select("*")
    .eq("status", "ativo");

  if (requestedId) {
    establishmentQuery = establishmentQuery.eq("id", requestedId);
  } else if (requestedSlug) {
    establishmentQuery = establishmentQuery.eq("slug", requestedSlug);
  } else {
    establishmentQuery = establishmentQuery.order("created_at", {
      ascending: true,
    });
  }

  const { data: establishmentRows, error: establishmentError } =
    await establishmentQuery.limit(1);

  if (establishmentError) {
    return errorResponse(
      establishmentError.message ?? "Falha ao carregar o estabelecimento.",
      400
    );
  }

  const establishmentRow = Array.isArray(establishmentRows)
    ? (establishmentRows[0] as EstablishmentRow | undefined)
    : undefined;

  if (!establishmentRow?.id) {
    const message =
      requestedId || requestedSlug
        ? "Estabelecimento não encontrado ou indisponível."
        : "Nenhum estabelecimento ativo cadastrado.";
    return errorResponse(message, 404);
  }

  const establishmentId = String(establishmentRow.id);
  const establishment = mapEstablishment(establishmentRow);

  // 2) Categorias + adicionais (ativos) do estabelecimento.
  const [categoriesRes, addonsRes] = await Promise.all([
    fetchWithOrderFallback<Category>((column) =>
      adminClient
        .from("categories")
        .select("*")
        .eq("establishment_id", establishmentId)
        .eq("is_active", true)
        .order(column, { ascending: true })
        .order("name", { ascending: true })
    ),
    fetchWithOrderFallback<MenuAddon>((column) =>
      adminClient
        .from("addons")
        .select("*")
        .eq("establishment_id", establishmentId)
        .eq("is_active", true)
        .order(column, { ascending: true })
        .order("name", { ascending: true })
    ),
  ]);

  if (categoriesRes.error) {
    return errorResponse(
      categoriesRes.error.message ?? "Falha ao carregar as categorias.",
      400
    );
  }

  // 3) Produtos ativos, com o nome da categoria via join (fallback sem join).
  const fetchProducts = (withJoin: boolean) =>
    fetchWithOrderFallback<ProductRow>((column) =>
      adminClient
        .from("products")
        .select(withJoin ? "*, categories ( name )" : "*")
        .eq("establishment_id", establishmentId)
        .eq("is_active", true)
        .order(column, { ascending: true })
        .order("name", { ascending: true })
    );

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

  if (productsRes.error) {
    return errorResponse(
      productsRes.error.message ?? "Falha ao carregar os produtos.",
      400
    );
  }

  const payload: StorefrontMenu = {
    establishment,
    categories: (categoriesRes.data ?? []) as Category[],
    products: ((productsRes.data ?? []) as ProductRow[]).map(mapProduct),
    addons: (addonsRes.data ?? []) as MenuAddon[],
  };

  return NextResponse.json(payload, { status: 200 });
}

