import { NextResponse } from "next/server";
import { requireMenuAccess } from "@/lib/supabase/menuGuard";
import { getSubscriptionPlan } from "@/lib/settings";
import {
  computeBillingCyclePrice,
  isBillingCycleId,
  type BillingCycleId,
} from "@/lib/subscriptions";
import {
  buildSubscriptionCouponQuote,
  isValidSubscriptionCouponCode,
  normalizeSubscriptionCouponCode,
  subscriptionCouponEligibilityError,
  toSubscriptionCouponNumber,
  type SubscriptionCouponRecord,
} from "@/lib/subscription-coupons";
import {
  findSubscriptionCouponByCode,
  SubscriptionCouponsSchemaError,
} from "@/lib/subscription-coupons-server";

/**
 * POST /api/billing/coupon — valida um cupom de assinatura.
 *
 * Body: `{ code: string, cycle?: "monthly" | "semiannual" | "annual" }`.
 * Exige sessão de admin (qualquer loja): o cupom é global, mas não deve ser
 * consultável sem autenticação.
 *
 * Devolve o resumo do período com o desconto aplicado
 * (`SubscriptionCouponQuote` + dados do cupom). O checkout recalcula tudo
 * novamente — esta rota serve apenas para a prévia no modal.
 */

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Objeto JSON (ou `null` quando o valor não é um objeto simples). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Ciclo enviado pelo cliente (mensal quando ausente/inválido). */
function readCycle(value: unknown): BillingCycleId | null {
  if (value === undefined || value === null || value === "") return "monthly";
  return isBillingCycleId(value) ? value : null;
}

export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(await request.json());
  } catch {
    body = null;
  }

  if (!body) return fail("Corpo da requisição inválido.");

  const code = normalizeSubscriptionCouponCode(
    typeof body.code === "string" ? body.code : ""
  );
  if (!code) return fail("Informe o código do cupom.");
  if (!isValidSubscriptionCouponCode(code)) {
    return fail("Código de cupom inválido. Confira o que foi digitado.");
  }

  const cycle = readCycle(body.cycle);
  if (!cycle) {
    return fail("Ciclo de cobrança inválido. Escolha mensal, semestral ou anual.");
  }

  const plan = await getSubscriptionPlan();
  const cyclePrice = computeBillingCyclePrice(plan.priceCents, cycle);

  let coupon: SubscriptionCouponRecord | null;
  try {
    coupon = await findSubscriptionCouponByCode(code);
  } catch (error) {
    if (error instanceof SubscriptionCouponsSchemaError) {
      console.error("[billing/coupon]", error.message);
      return fail("Os cupons de assinatura estão indisponíveis no momento.", 503);
    }

    console.error("[billing/coupon] falha ao consultar o cupom", error);
    return fail("Não foi possível validar o cupom agora. Tente novamente.", 500);
  }

  if (!coupon) {
    return fail("Cupom não encontrado. Confira o código digitado.", 404);
  }

  const eligibilityError = subscriptionCouponEligibilityError(
    coupon,
    cyclePrice.totalCents
  );
  if (eligibilityError) return fail(eligibilityError);

  const quote = buildSubscriptionCouponQuote(cyclePrice, coupon);
  if (quote.totalCents <= 0) {
    return fail(
      "Este cupom não pode ser aplicado: o desconto zera o valor da assinatura."
    );
  }

  return NextResponse.json(
    {
      ...quote,
      discountType: coupon.discount_type,
      discountValue: toSubscriptionCouponNumber(coupon.discount_value),
      // Contexto do período (útil para o resumo do modal).
      monthlyCents: cyclePrice.monthlyCents,
      cycleDiscountPercent: cyclePrice.discountPercent,
      cycleDiscountCents: cyclePrice.discountCents,
      cycleListCents: cyclePrice.listCents,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}