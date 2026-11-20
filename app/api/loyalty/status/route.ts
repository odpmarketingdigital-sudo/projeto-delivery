import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  buildLoyaltyStatus,
} from "@/lib/loyalty-server";
import { LOYALTY_PHONE_MIN_DIGITS, normalizeLoyaltyPhone } from "@/lib/loyalty";
import { roundCurrency } from "@/lib/coupons";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type StatusBody = {
  establishmentId?: unknown;
  establishment_id?: unknown;
  slug?: unknown;
  phone?: unknown;
  customerPhone?: unknown;
  customer_phone?: unknown;
  subtotal?: unknown;
  deliveryFee?: unknown;
  delivery_fee?: unknown;
};

/**
 * POST /api/loyalty/status — prévia do programa de fidelidade (rota PÚBLICA).
 *
 * O checkout usa esta rota para mostrar saldo, progresso e o desconto que o
 * resgate aplicaria no carrinho atual. Nada é gravado: a validação definitiva
 * (saldo, pedido mínimo e desconto) acontece em POST /api/orders.
 *
 * Body: { establishmentId? | establishment_id? | slug?, phone, subtotal,
 *         deliveryFee? }
 */
export async function POST(request: Request) {
  let body: StatusBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const phone = normalizeLoyaltyPhone(
    body.phone !== undefined ? body.phone : body.customerPhone !== undefined
      ? body.customerPhone
      : body.customer_phone
  );
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS) {
    return NextResponse.json(
      {
        error: "Informe seu telefone com DDD para consultar seus pontos.",
      },
      { status: 400 }
    );
  }

  const rawSubtotal = Number(body.subtotal);
  const subtotal =
    Number.isFinite(rawSubtotal) && rawSubtotal > 0
      ? roundCurrency(rawSubtotal)
      : 0;

  const rawDeliveryFee = Number(
    body.deliveryFee !== undefined ? body.deliveryFee : body.delivery_fee
  );
  const deliveryFee =
    Number.isFinite(rawDeliveryFee) && rawDeliveryFee > 0
      ? roundCurrency(rawDeliveryFee)
      : 0;

  const rawId = (
    typeof body.establishmentId === "string"
      ? body.establishmentId
      : typeof body.establishment_id === "string"
        ? body.establishment_id
        : ""
  ).trim();
  const rawSlug =
    typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";

  const adminClient = createAdminClient();

  let establishmentId = rawId && UUID_REGEX.test(rawId) ? rawId : null;
  const slugCandidate = rawSlug || (rawId && !establishmentId ? rawId.toLowerCase() : "");

  if (!establishmentId && slugCandidate) {
    const { data } = await adminClient
      .from("establishments")
      .select("id")
      .eq("slug", slugCandidate)
      .maybeSingle();
    establishmentId = typeof data?.id === "string" ? data.id : null;
  }

  if (!establishmentId) {
    return NextResponse.json(
      { error: "Loja não identificada para consultar os pontos." },
      { status: 400 }
    );
  }

  const status = await buildLoyaltyStatus(adminClient, {
    establishmentId,
    phone,
    subtotal,
    deliveryFee,
  });

  return NextResponse.json({ status }, { status: 200 });
}
