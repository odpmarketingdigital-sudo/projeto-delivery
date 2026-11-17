/**
 * Rótulos das formas de pagamento do checkout (`orders.payment_method`).
 *
 * Módulo puro compartilhado pelo WhatsApp (`lib/whatsappOrder.ts`), pelo painel
 * (`OrderCard`/`OrderDetailsModal`), pelo acompanhamento (`PedidoTracker`) e por
 * "Meus Pedidos" (`/[slug]/pedidos`). A ideia é ter UM único texto para cada
 * forma de pagamento — inclusive o vale-refeição, que precisa deixar claro que
 * a cobrança é presencial, na entrega.
 */

import {
  CARD_PAYMENT_METHOD,
  cardPaymentDetailLabel,
} from "@/lib/cardBrands";
import {
  MEAL_VOUCHER_PAYMENT_METHOD,
  mealVoucherPaymentLabel,
} from "@/lib/mealVouchers";

/** Rótulos base (cartão e vale-refeição dependem do que o cliente escolheu). */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  pix: "Pix",
  [CARD_PAYMENT_METHOD]: "Cartão na entrega",
  dinheiro: "Dinheiro",
  pix_online: "PIX Online",
  [MEAL_VOUCHER_PAYMENT_METHOD]: "Vale-Refeição - na entrega",
};

/**
 * Rótulo final da forma de pagamento.
 *
 * - Vale-refeição: inclui a bandeira escolhida ("Vale-Refeição (Alelo) - na
 *   entrega") para o entregador levar a maquininha correta;
 * - Cartão na entrega: inclui tipo e bandeira escolhidos ("Cartão na entrega
 *   (Crédito · Visa)") — informação que o entregador precisa conferir antes de
 *   passar o cartão;
 * - Demais formas: rótulo de `PAYMENT_METHOD_LABELS`;
 * - Valor desconhecido: devolve o próprio código (mesmo comportamento das
 *   telas antes deste helper);
 * - Vazio/ausente: string vazia (cada tela decide o fallback).
 */
export function paymentMethodLabel(
  paymentMethod: string | null | undefined,
  mealVoucher?: string | null,
  cardBrand?: string | null,
  cardType?: string | null
): string {
  const method = typeof paymentMethod === "string" ? paymentMethod.trim() : "";
  if (!method) return "";
  if (method === MEAL_VOUCHER_PAYMENT_METHOD) {
    return mealVoucherPaymentLabel(mealVoucher);
  }
  if (method === CARD_PAYMENT_METHOD) {
    const base = PAYMENT_METHOD_LABELS[CARD_PAYMENT_METHOD];
    const detail = cardPaymentDetailLabel(cardType, cardBrand);
    return detail ? `${base} (${detail})` : base;
  }
  return PAYMENT_METHOD_LABELS[method] ?? method;
}
