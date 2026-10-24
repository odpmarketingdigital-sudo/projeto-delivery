/**
 * Tipos e cálculos compartilhados de cupons de desconto.
 *
 * Este módulo é puro (sem dependências de servidor) e por isso pode ser
 * importado tanto pelas rotas de API (`/api/coupons*`, `/api/orders`) quanto
 * pelo checkout no navegador (`CheckoutForm`).
 */

export type CouponDiscountType = "percentage" | "fixed";

/** Linha de `public.coupons` (valores numéricos podem vir como string do PostgREST). */
export interface CouponRecord {
  id: string;
  establishment_id: string;
  code: string;
  discount_type: CouponDiscountType;
  discount_value: number | string;
  min_order_value: number | string | null;
  usage_limit: number | string | null;
  used_count: number | string;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Dados mínimos de um cupom já validado, usados no cálculo do checkout. */
export interface AppliedCoupon {
  code: string;
  discount_type: CouponDiscountType;
  discount_value: number;
  min_order_value: number | null;
  usage_limit?: number | null;
  used_count?: number;
}

/** Código: 3–40 caracteres, começando por letra/dígito (ex.: DESCONTO10). */
export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

/** Normaliza o código digitado para o formato persistido (caixa alta). */
export function normalizeCouponCode(value: string): string {
  return value.trim().toUpperCase();
}

/** true = código com formato aceito pela API e pelo banco. */
export function isValidCouponCode(code: string): boolean {
  return COUPON_CODE_PATTERN.test(code);
}

/** Converte valores numéricos tolerando string/null/undefined. */
export function toCouponNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Arredonda valores monetários para 2 casas (centavos). */
export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Formata um valor como BRL (ex.: 26.9 → "R$ 26,90"). */
export function formatCouponBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

/**
 * Calcula o desconto do cupom sobre o SUBTOTAL (sem taxa de entrega).
 *
 * Regras:
 *  - `percentage`: percentual sobre o subtotal;
 *  - `fixed`: valor fixo, limitado ao próprio subtotal;
 *  - pedido abaixo de `min_order_value` → desconto 0.
 */
export function computeCouponDiscount(
  coupon: Pick<
    AppliedCoupon,
    "discount_type" | "discount_value" | "min_order_value"
  >,
  subtotal: number
): number {
  const base =
    Number.isFinite(subtotal) && subtotal > 0 ? roundCurrency(subtotal) : 0;
  if (base <= 0) return 0;

  const min = coupon.min_order_value;
  if (min != null && base < min) return 0;

  const value = toCouponNumber(coupon.discount_value);
  const raw =
    coupon.discount_type === "percentage" ? (base * value) / 100 : value;
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  return roundCurrency(Math.min(raw, base));
}

/**
 * Verifica se o cupom pode ser usado para o subtotal informado.
 * Retorna a mensagem de erro (pt-BR) ou `null` quando está tudo certo.
 */
export function couponEligibilityError(
  coupon: Pick<CouponRecord, "active" | "usage_limit" | "used_count"> & {
    min_order_value?: number | string | null;
  },
  subtotal: number
): string | null {
  if (!coupon.active) {
    return "Este cupom não está mais ativo.";
  }

  const limit =
    coupon.usage_limit == null ? null : toCouponNumber(coupon.usage_limit);
  const used = toCouponNumber(coupon.used_count);
  if (limit != null && limit > 0 && used >= limit) {
    return "Este cupom atingiu o limite de usos.";
  }

  const min =
    coupon.min_order_value == null
      ? null
      : toCouponNumber(coupon.min_order_value);
  if (min != null && min > 0 && subtotal < min) {
    return `Este cupom exige um pedido mínimo de ${formatCouponBRL(min)}.`;
  }

  return null;
}

/** Rótulo curto do desconto (ex.: "10%" ou "R$ 5,00"). */
export function couponDiscountLabel(
  coupon: Pick<AppliedCoupon, "discount_type" | "discount_value">
): string {
  if (coupon.discount_type === "percentage") {
    return `${toCouponNumber(coupon.discount_value)}%`;
  }
  return formatCouponBRL(toCouponNumber(coupon.discount_value));
}
