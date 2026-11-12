/**
 * Tipos e cálculos compartilhados de cupons de desconto.
 *
 * Este módulo é puro (sem dependências de servidor) e por isso pode ser
 * importado tanto pelas rotas de API (`/api/coupons*`, `/api/orders`) quanto
 * pelo checkout no navegador (`CheckoutForm`).
 */

export type CouponDiscountType = "percentage" | "fixed" | "free_shipping";

/** Linha de `public.coupons` (valores numéricos podem vir como string do PostgREST). */
export interface CouponRecord {
  id: string;
  establishment_id: string;
  code: string;
  discount_type: CouponDiscountType;
  discount_value: number | string;
  min_order_value: number | string | null;
  /** Limite global de usos (null = ilimitado). */
  max_uses?: number | string | null;
  /**
   * @deprecated Nome anterior da coluna `max_uses`. Mantido apenas para bases
   * que ainda não executaram a migração 20261111000002_extend_coupons.sql.
   */
  usage_limit?: number | string | null;
  used_count: number | string;
  /** Só pode ser usado por clientes sem pedidos anteriores na loja. */
  first_order_only?: boolean;
  /** Data/hora limite de validade (null = sem validade). */
  expires_at?: string | null;
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
  max_uses?: number | null;
  usage_limit?: number | null;
  used_count?: number;
  first_order_only?: boolean;
  expires_at?: string | null;
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
 * Limite de usos efetivo do cupom.
 *
 * Prefere `max_uses` (nome canônico) e cai em `usage_limit` apenas para bases
 * que ainda não executaram a migração 20261111000002_extend_coupons.sql.
 */
export function couponMaxUses(coupon: {
  max_uses?: number | string | null;
  usage_limit?: number | string | null;
}): number | null {
  const raw = coupon.max_uses ?? coupon.usage_limit;
  return raw == null ? null : toCouponNumber(raw);
}

/**
 * Calcula o desconto do cupom no pedido.
 *
 * Regras:
 *  - `percentage`: percentual sobre o subtotal;
 *  - `fixed`: valor fixo, limitado ao próprio subtotal;
 *  - `free_shipping`: abate integralmente a taxa de entrega informada;
 *  - pedido abaixo de `min_order_value` → desconto 0.
 *
 * O resultado nunca ultrapassa o valor da base correspondente (subtotal nos
 * descontos em dinheiro, taxa de entrega no frete grátis).
 */
export function computeCouponDiscount(
  coupon: Pick<
    AppliedCoupon,
    "discount_type" | "discount_value" | "min_order_value"
  >,
  subtotal: number,
  deliveryFee = 0
): number {
  const base =
    Number.isFinite(subtotal) && subtotal > 0 ? roundCurrency(subtotal) : 0;
  if (base <= 0) return 0;

  const min = coupon.min_order_value;
  if (min != null && base < toCouponNumber(min)) return 0;

  if (coupon.discount_type === "free_shipping") {
    const fee =
      Number.isFinite(deliveryFee) && deliveryFee > 0
        ? roundCurrency(deliveryFee)
        : 0;
    return fee;
  }

  const value = toCouponNumber(coupon.discount_value);
  const raw =
    coupon.discount_type === "percentage" ? (base * value) / 100 : value;
  if (!Number.isFinite(raw) || raw <= 0) return 0;

  return roundCurrency(Math.min(raw, base));
}

/**
 * Verifica se o cupom pode ser usado para o subtotal informado.
 * Retorna a mensagem de erro (pt-BR) ou `null` quando está tudo certo.
 *
 * A regra de "apenas no primeiro pedido" depende da tabela `orders` e por isso
 * é validada nas rotas de servidor (`/api/coupons/validate` e `/api/orders`).
 */
export function couponEligibilityError(
  coupon: Pick<CouponRecord, "active" | "used_count"> & {
    max_uses?: number | string | null;
    usage_limit?: number | string | null;
    min_order_value?: number | string | null;
    expires_at?: string | null;
  },
  subtotal: number
): string | null {
  if (!coupon.active) {
    return "Este cupom não está mais ativo.";
  }

  if (coupon.expires_at) {
    const expiresAt = new Date(coupon.expires_at);
    if (
      !Number.isNaN(expiresAt.getTime()) &&
      expiresAt.getTime() <= Date.now()
    ) {
      return "Este cupom expirou.";
    }
  }

  const limit = couponMaxUses(coupon);
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

/** Rótulo do tipo de desconto exibido no painel. */
export function couponDiscountTypeLabel(type: CouponDiscountType): string {
  switch (type) {
    case "free_shipping":
      return "Frete grátis";
    case "fixed":
      return "Valor fixo";
    case "percentage":
    default:
      return "Percentual";
  }
}

/** Rótulo curto do desconto (ex.: "10%", "R$ 5,00" ou "Frete grátis"). */
export function couponDiscountLabel(
  coupon: Pick<AppliedCoupon, "discount_type" | "discount_value">
): string {
  if (coupon.discount_type === "free_shipping") {
    return "Frete grátis";
  }
  if (coupon.discount_type === "percentage") {
    return `${toCouponNumber(coupon.discount_value)}%`;
  }
  return formatCouponBRL(toCouponNumber(coupon.discount_value));
}

/** Normaliza o telefone do cliente para a checagem de primeiro pedido. */
export function normalizeCouponPhone(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}
