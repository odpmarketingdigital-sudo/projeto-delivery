import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  computeCouponDiscount,
  couponEligibilityError,
  isValidCouponCode,
  normalizeCouponCode,
  normalizeCouponPhone,
  roundCurrency,
  toCouponNumber,
  type CouponRecord,
} from "@/lib/coupons";
import {
  COUPON_PHONE_MIN_DIGITS,
  customerHasPreviousOrders,
} from "@/lib/coupons-server";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type ValidateBody = {
  /** Nome canônico (camelCase) e aliases aceitos pela vitrine. */
  establishmentId?: unknown;
  establishment_id?: unknown;
  slug?: unknown;
  code?: unknown;
  subtotal?: unknown;
  deliveryFee?: unknown;
  delivery_fee?: unknown;
  customerPhone?: unknown;
  customer_phone?: unknown;
};

/**
 * POST /api/coupons/validate — valida um cupom no checkout (rota PÚBLICA).
 *
 * O cliente da vitrine não tem sessão; a rota apenas LÊ o cupom da loja e
 * devolve o desconto calculado. A aplicação definitiva (gravação do pedido e
 * incremento de `used_count`) acontece em POST /api/orders, que revalida tudo.
 *
 * Body: { establishmentId? | establishment_id? | slug?, code, subtotal,
 *         deliveryFee?, customerPhone? }
 *
 * `customerPhone` é obrigatório para cupons com `first_order_only`: a rota
 * consulta `orders` (ignorando cancelados) e recusa clientes com compras
 * anteriores na loja.
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

  const rawDeliveryFee =
    body.deliveryFee !== undefined ? body.deliveryFee : body.delivery_fee;
  const parsedDeliveryFee = Number(rawDeliveryFee);
  const deliveryFee =
    rawDeliveryFee === undefined || rawDeliveryFee === null
      ? 0
      : Number.isFinite(parsedDeliveryFee) && parsedDeliveryFee > 0
        ? roundCurrency(parsedDeliveryFee)
        : 0;

  const customerPhone = normalizeCouponPhone(
    body.customerPhone !== undefined
      ? body.customerPhone
      : body.customer_phone
  );

  const adminClient = createAdminClient();

  // Resolve a loja por UUID, `establishment_id` ou slug (mesmo padrão de
  // POST /api/orders).
  const rawEstablishmentId =
    typeof body.establishmentId === "string"
      ? body.establishmentId.trim()
      : typeof body.establishment_id === "string"
        ? body.establishment_id.trim()
        : "";

  let establishmentId =
    rawEstablishmentId && UUID_REGEX.test(rawEstablishmentId)
      ? rawEstablishmentId
      : null;

  if (!establishmentId) {
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
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

  // Garantia de tipo: o bloco de resolução acima sempre define a loja (UUID
  // direto ou encontrado pelo slug) ou retorna uma resposta de erro.
  if (!establishmentId) {
    return NextResponse.json(
      { error: "Não foi possível identificar a loja do pedido." },
      { status: 400 }
    );
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
          ? "Cupons indisponíveis no momento. Execute as migrações de cupons no Supabase."
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

  // "Apenas no primeiro pedido": exige telefone e nenhum pedido anterior
  // (cancelados não contam).
  if (coupon.first_order_only === true) {
    if (customerPhone.length < COUPON_PHONE_MIN_DIGITS) {
      return NextResponse.json(
        {
          error:
            "Informe seu telefone com DDD para validar este cupom de primeiro pedido.",
        },
        { status: 400 }
      );
    }
    const hasPreviousOrders = await customerHasPreviousOrders(adminClient, {
      establishmentId,
      phone: customerPhone,
    });
    if (hasPreviousOrders) {
      return NextResponse.json(
        { error: "Cupom válido apenas para o primeiro pedido." },
        { status: 400 }
      );
    }
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
    subtotal,
    deliveryFee
  );

  if (discount <= 0) {
    return NextResponse.json(
      {
        error:
          coupon.discount_type === "free_shipping"
            ? "O frete deste pedido já é grátis — este cupom não gera desconto."
            : "Este cupom não gera desconto para este pedido.",
      },
      { status: 400 }
    );
  }

  const total = roundCurrency(
    Math.max(0, subtotal + deliveryFee - discount)
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
        max_uses:
          coupon.max_uses == null ? null : toCouponNumber(coupon.max_uses),
        usage_limit:
          coupon.usage_limit == null ? null : toCouponNumber(coupon.usage_limit),
        used_count: toCouponNumber(coupon.used_count),
        first_order_only: coupon.first_order_only === true,
        expires_at: coupon.expires_at ?? null,
        active: coupon.active,
      },
      subtotal: roundCurrency(subtotal),
      deliveryFee,
      /** Valor a abater do total (frete ou subtotal, conforme o tipo). */
      discountAmount: discount,
      /** Alias legado consumido por versões anteriores do checkout. */
      discount,
      total,
    },
    { status: 200 }
  );
}
