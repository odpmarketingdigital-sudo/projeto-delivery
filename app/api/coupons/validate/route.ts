import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  computeCouponDiscount,
  couponEligibilityError,
  isValidCouponCode,
  normalizeCouponCode,
  roundCurrency,
  toCouponNumber,
  type CouponRecord,
} from "@/lib/coupons";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type ValidateBody = {
  establishment_id?: unknown;
  slug?: unknown;
  code?: unknown;
  subtotal?: unknown;
};

/**
 * POST /api/coupons/validate — valida um cupom no checkout (rota PÚBLICA).
 *
 * O cliente da vitrine não tem sessão; a rota apenas LÊ o cupom da loja e
 * devolve o desconto calculado. A aplicação definitiva (gravação do pedido e
 * incremento de `used_count`) acontece em POST /api/orders, que revalida tudo.
 *
 * Body: { establishment_id? | slug?, code, subtotal }
 */
export async function POST(request: Request) {
  let body: ValidateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const code = normalizeCouponCode(
    typeof body.code === "string" ? body.code : ""
  );
  if (!code) {
    return NextResponse.json(
      { error: "Informe o código do cupom." },
      { status: 400 }
    );
  }
  if (!isValidCouponCode(code)) {
    return NextResponse.json(
      { error: "Código de cupom inválido." },
      { status: 400 }
    );
  }

  const subtotal = Number(body.subtotal);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    return NextResponse.json(
      { error: "Não foi possível calcular o cupom com um carrinho vazio." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // Resolve a loja por UUID ou slug (mesmo padrão de POST /api/orders).
  let establishmentId =
    typeof body.establishment_id === "string" &&
    UUID_REGEX.test(body.establishment_id.trim())
      ? body.establishment_id.trim()
      : null;

  if (!establishmentId) {
    const slug =
      typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) {
      return NextResponse.json(
        { error: "Não foi possível identificar a loja do pedido." },
        { status: 400 }
      );
    }
    const { data: establishment, error: slugError } = await adminClient
      .from("establishments")
      .select("id")
      .ilike("slug", slug)
      .maybeSingle();

    if (slugError) {
      return NextResponse.json(
        { error: slugError.message ?? "Falha ao consultar a loja." },
        { status: 400 }
      );
    }
    if (!establishment) {
      return NextResponse.json(
        { error: `Estabelecimento não encontrado para o slug "${slug}".` },
        { status: 404 }
      );
    }
    establishmentId = establishment.id;
  }

  // A loja precisa existir e estar ativa (mesma regra da vitrine).
  const { data: store, error: storeError } = await adminClient
    .from("establishments")
    .select("id, status")
    .eq("id", establishmentId)
    .maybeSingle();

  if (storeError) {
    return NextResponse.json(
      { error: storeError.message ?? "Falha ao consultar a loja." },
      { status: 400 }
    );
  }
  if (!store || store.status !== "ativo") {
    return NextResponse.json(
      { error: "Estabelecimento indisponível no momento." },
      { status: 404 }
    );
  }

  const { data: couponRow, error: couponError } = await adminClient
    .from("coupons")
    .select("*")
    .eq("establishment_id", establishmentId)
    .eq("code", code)
    .maybeSingle();

  if (couponError) {
    const message = couponError.message ?? "Falha ao validar o cupom.";
    const missingTable = /does not exist|schema cache|could not find/i.test(
      message
    );
    return NextResponse.json(
      {
        error: missingTable
          ? "Cupons indisponíveis no momento. Execute a migração 20261110000011_create_coupons.sql no Supabase."
          : message,
      },
      { status: 400 }
    );
  }

  if (!couponRow) {
    return NextResponse.json(
      { error: `Cupom "${code}" não encontrado nesta loja.` },
      { status: 404 }
    );
  }

  const coupon = couponRow as CouponRecord;
  const eligibilityError = couponEligibilityError(coupon, subtotal);
  if (eligibilityError) {
    return NextResponse.json({ error: eligibilityError }, { status: 400 });
  }

  const discount = computeCouponDiscount(
    {
      discount_type: coupon.discount_type,
      discount_value: toCouponNumber(coupon.discount_value),
      min_order_value:
        coupon.min_order_value == null
          ? null
          : toCouponNumber(coupon.min_order_value),
    },
    subtotal
  );

  return NextResponse.json(
    {
      coupon: {
        code: coupon.code,
        discount_type: coupon.discount_type,
        discount_value: toCouponNumber(coupon.discount_value),
        min_order_value:
          coupon.min_order_value == null
            ? null
            : toCouponNumber(coupon.min_order_value),
        usage_limit:
          coupon.usage_limit == null
            ? null
            : toCouponNumber(coupon.usage_limit),
        used_count: toCouponNumber(coupon.used_count),
        active: coupon.active,
      },
      subtotal: roundCurrency(subtotal),
      discount,
      total: roundCurrency(Math.max(0, subtotal - discount)),
    },
    { status: 200 }
  );
}
