/**
 * Cupons de desconto da ASSINATURA (SaaS).
 *
 * Diferente de `lib/coupons.ts` (cupons do cardápio, por estabelecimento),
 * estes cupons são globais: criados pelo Super Admin em `/painel/admin/cupons`
 * e aplicados no checkout da assinatura sobre o TOTAL do período escolhido
 * (mensal, semestral ou anual).
 *
 * Módulo puro (sem dependências de servidor), compartilhado por:
 *  - `/api/billing/coupon` (validar no modal de checkout);
 *  - `/api/billing/checkout` (recalcular antes de cobrar);
 *  - `/api/admin/subscription-coupons` (CRUD do Super Admin);
 *  - `/painel/admin/cupons` e `CheckoutModal` (UI).
 */

import {
  formatCouponBRL,
  isValidCouponCode,
  normalizeCouponCode,
  roundCurrency,
  toCouponNumber,
  type CouponDiscountType,
} from "./coupons";
import { formatBRL, type BillingCycleId, type BillingCyclePrice } from "./subscriptions";

export type SubscriptionCouponDiscountType = CouponDiscountType;

/** Tipos de desconto aceitos no cadastro (percentual ou valor fixo). */
export const SUBSCRIPTION_COUPON_DISCOUNT_TYPES = [
  "percentage",
  "fixed",
] as const;

/** Rótulos exibidos no formulário e nas listas. */
export const SUBSCRIPTION_COUPON_DISCOUNT_TYPE_LABELS: Record<
  SubscriptionCouponDiscountType,
  string
> = {
  percentage: "Percentual (%)",
  fixed: "Valor fixo (R$)",
};

/** Limite de caracteres do campo `code` (mesma regra da lib de cupons). */
export const SUBSCRIPTION_COUPON_MAX_CODE_LENGTH = 40;

/** Limite máximo aceito para um desconto percentual. */
export const SUBSCRIPTION_COUPON_MAX_PERCENT = 100;

/** Linha de `public.subscription_coupons`. */
export interface SubscriptionCouponRecord {
  id: string;
  code: string;
  discount_type: SubscriptionCouponDiscountType;
  /** Numérico do PostgREST pode chegar como string. */
  discount_value: number | string;
  usage_limit: number | string | null;
  used_count: number | string;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Campos graváveis (payload já validado/normalizado). */
export interface SubscriptionCouponFields {
  code: string;
  discount_type: SubscriptionCouponDiscountType;
  discount_value: number;
  usage_limit: number | null;
  active: boolean;
}

/** `true` quando o valor é um tipo de desconto aceito. */
export function isSubscriptionCouponDiscountType(
  value: unknown
): value is SubscriptionCouponDiscountType {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_COUPON_DISCOUNT_TYPES as readonly string[]).includes(value)
  );
}

/** Normaliza o código digitado (caixa alta, sem espaços nas pontas). */
export function normalizeSubscriptionCouponCode(value: string): string {
  return normalizeCouponCode(value);
}

/** `true` quando o código tem o formato aceito pela API e pelo banco. */
export function isValidSubscriptionCouponCode(code: string): boolean {
  return isValidCouponCode(code);
}

/** Converte valores numéricos do banco (`numeric` chega como string). */
export function toSubscriptionCouponNumber(value: unknown): number {
  return toCouponNumber(value);
}

/** Usos restantes do cupom (`null` = ilimitado). */
export function subscriptionCouponRemainingUsages(
  coupon: Pick<SubscriptionCouponRecord, "usage_limit" | "used_count">
): number | null {
  const limit =
    coupon.usage_limit == null ? null : toCouponNumber(coupon.usage_limit);
  if (limit == null || limit <= 0) return null;
  return Math.max(0, limit - toCouponNumber(coupon.used_count));
}

/** Rótulo curto do desconto (ex.: "10%" ou "R$ 20,00"). */
export function subscriptionCouponDiscountLabel(
  coupon: Pick<SubscriptionCouponRecord, "discount_type" | "discount_value">
): string {
  const value = toCouponNumber(coupon.discount_value);
  return coupon.discount_type === "percentage"
    ? `${value}%`
    : formatCouponBRL(value);
}

/**
 * Valida o payload completo de um cupom de assinatura.
 *
 * Usado no `POST` e no `PATCH` (o PATCH mescla a linha atual com o body antes
 * de chamar esta função, então aqui todos os campos são considerados).
 */
export function validateSubscriptionCouponFields(
  input: Record<string, unknown>
): { fields: SubscriptionCouponFields | null; error: string | null } {
  const rawCode = typeof input.code === "string" ? input.code : "";
  const code = normalizeSubscriptionCouponCode(rawCode);
  if (!code) {
    return { fields: null, error: "Informe o código do cupom." };
  }
  if (!isValidSubscriptionCouponCode(code)) {
    return {
      fields: null,
      error: `Código inválido. Use de 3 a ${SUBSCRIPTION_COUPON_MAX_CODE_LENGTH} caracteres (letras, números, hífen ou sublinhado).`,
    };
  }

  if (!isSubscriptionCouponDiscountType(input.discount_type)) {
    return {
      fields: null,
      error: "Tipo de desconto inválido. Use percentage ou fixed.",
    };
  }
  const discountType = input.discount_type;

  const discountValue = Number(input.discount_value);
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    return {
      fields: null,
      error: "Informe um valor de desconto maior que zero.",
    };
  }
  if (
    discountType === "percentage" &&
    discountValue > SUBSCRIPTION_COUPON_MAX_PERCENT
  ) {
    return {
      fields: null,
      error: "O desconto percentual deve ser de no máximo 100%.",
    };
  }

  let usageLimit: number | null = null;
  const rawLimit = input.usage_limit;
  if (rawLimit !== null && rawLimit !== undefined && rawLimit !== "") {
    const parsedLimit = Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return {
        fields: null,
        error: "O limite de usos deve ser um número inteiro maior que zero.",
      };
    }
    usageLimit = parsedLimit;
  }

  return {
    fields: {
      code,
      discount_type: discountType,
      discount_value: roundCurrency(discountValue),
      usage_limit: usageLimit,
      active: input.active === undefined ? true : Boolean(input.active),
    },
    error: null,
  };
}

/**
 * Calcula o desconto do cupom sobre o total do período, em centavos.
 * Nunca devolve valor maior que o próprio total.
 */
export function computeSubscriptionCouponDiscount(
  coupon: Pick<SubscriptionCouponRecord, "discount_type" | "discount_value">,
  amountCents: number
): number {
  const base =
    Number.isFinite(amountCents) && amountCents > 0
      ? Math.round(amountCents)
      : 0;
  if (base <= 0) return 0;

  const value = toCouponNumber(coupon.discount_value);
  const raw =
    coupon.discount_type === "percentage" ? (base * value) / 100 : value * 100;
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  return Math.min(Math.round(raw), base);
}

/**
 * Motivo pelo qual o cupom NÃO pode ser usado (ou `null` quando pode).
 * Espelha `couponEligibilityError` da lib de cupons do cardápio.
 */
export function subscriptionCouponEligibilityError(
  coupon: Pick<
    SubscriptionCouponRecord,
    "active" | "usage_limit" | "used_count"
  >,
  amountCents: number
): string | null {
  if (!coupon.active) {
    return "Este cupom não está mais ativo.";
  }

  const remaining = subscriptionCouponRemainingUsages(coupon);
  if (remaining !== null && remaining <= 0) {
    return "Este cupom atingiu o limite de usos.";
  }

  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return "Não foi possível calcular o valor da assinatura para aplicar o cupom.";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Resumo do período (subtotal, desconto e total)
// ---------------------------------------------------------------------------

/** Resumo devolvido por `/api/billing/coupon` e exibido no modal. */
export interface SubscriptionCouponQuote {
  cycle: BillingCycleId;
  cycleLabel: string;
  durationLabel: string;
  /** Total do período sem o cupom (centavos). */
  subtotalCents: number;
  /** Desconto do cupom (centavos). */
  discountCents: number;
  /** Total cobrado no período (centavos). */
  totalCents: number;
  totalLabel: string;
  /** Rótulo do desconto (ex.: "10%"); `null` sem cupom. */
  discountLabel: string | null;
  couponCode: string | null;
}

/**
 * Monta o resumo do período já com o cupom aplicado.
 *
 * O ciclo (mensal/semestral/anual) define o subtotal — o desconto do ciclo já
 * vem embutido em `BillingCyclePrice.totalCents`; o cupom incide sobre ele.
 */
export function buildSubscriptionCouponQuote(
  cyclePrice: BillingCyclePrice,
  coupon: Pick<
    SubscriptionCouponRecord,
    "code" | "discount_type" | "discount_value"
  > | null
): SubscriptionCouponQuote {
  const subtotalCents = cyclePrice.totalCents;
  const discountCents = coupon
    ? computeSubscriptionCouponDiscount(coupon, subtotalCents)
    : 0;
  const totalCents = Math.max(0, subtotalCents - discountCents);

  return {
    cycle: cyclePrice.id,
    cycleLabel: cyclePrice.label,
    durationLabel: cyclePrice.durationLabel,
    subtotalCents,
    discountCents,
    totalCents,
    totalLabel: formatBRL(totalCents),
    discountLabel: coupon ? subscriptionCouponDiscountLabel(coupon) : null,
    couponCode: coupon?.code ?? null,
  };
}

