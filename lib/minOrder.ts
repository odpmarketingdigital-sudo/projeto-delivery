/**
 * Pedido mínimo por estabelecimento (`establishments.min_order_value`).
 *
 * Módulo puro (sem dependências de servidor): usado pela vitrine, pela sacola
 * (`CartDrawer`), pelo checkout (`CheckoutForm`) e por `POST /api/orders`. A
 * mensagem exibida ao cliente é a MESMA em todos os pontos — inclusive na
 * validação autoritativa do servidor.
 *
 * Regra: o mínimo é comparado com o subtotal dos itens (antes da taxa de
 * entrega) e nunca com o total do pedido.
 */

import { roundCurrency } from "@/lib/coupons";

/** Formata um valor como BRL (ex.: 25 → "R$ 25,00"). */
function formatMoney(value: number): string {
  return `R$ ${roundCurrency(value).toFixed(2).replace(".", ",")}`;
}

/**
 * Normaliza o pedido mínimo vindo do banco/API (pode chegar como string do
 * PostgREST). Valores ausentes, inválidos ou negativos viram `0`, ou seja,
 * loja sem pedido mínimo.
 */
export function normalizeMinOrderValue(value: unknown): number {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return roundCurrency(parsed);
}

/**
 * Quanto falta (em reais) para atingir o pedido mínimo.
 * Retorna `0` quando o subtotal já atende ou quando a loja não tem mínimo.
 */
export function minOrderShortfall(
  minOrderValue: number,
  subtotal: number
): number {
  if (minOrderValue <= 0) return 0;
  return Math.max(0, roundCurrency(minOrderValue - subtotal));
}

/**
 * Mensagem de bloqueio exibida na sacola/checkout e devolvida pela API.
 * `null` quando o pedido mínimo foi atingido (ou quando não existe).
 *
 * Ex.: "O valor mínimo para pedidos nesta loja é de R$ 25,00. Adicione mais
 * R$ 5,00 em produtos para continuar."
 */
export function describeMinOrderShortfall(
  minOrderValue: number,
  subtotal: number
): string | null {
  const shortfall = minOrderShortfall(minOrderValue, subtotal);
  if (shortfall <= 0) return null;

  return (
    `O valor mínimo para pedidos nesta loja é de ${formatMoney(minOrderValue)}. ` +
    `Adicione mais ${formatMoney(shortfall)} em produtos para continuar.`
  );
}
