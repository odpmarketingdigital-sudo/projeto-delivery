/**
 * Persistência do status de pagamento online dos pedidos (server-side).
 *
 * Vive fora das rotas porque o webhook do Asaas (`/api/asaas/webhook`) e a
 * conciliação por polling (`/api/asaas/pix-payment`) precisam gravar o mesmo
 * estado — sempre de forma idempotente, já que o Asaas entrega eventos
 * "at least once" e o cliente consulta o status em paralelo.
 *
 * A tabela `orders` também é assinada pelo Realtime do Supabase no painel
 * (`postgres_changes` filtrado por `establishment_id`, migração
 * 20261110000021): o UPDATE feito aqui chega sozinho ao Kanban e ao
 * acompanhamento do cliente, sem precisar de push manual.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Status de pagamento gravados em `orders.payment_status`. */
export const ORDER_PAYMENT_STATUS = {
  /** Cobrança gerada / pedido aguardando pagamento. */
  pending: "pendente",
  /** Pagamento confirmado pelo Asaas (PAYMENT_CONFIRMED/PAYMENT_RECEIVED). */
  paid: "pago",
  /** QR Code expirado sem pagamento. */
  expired: "expirado",
  /** Cobrança estornada/cancelada no gateway. */
  canceled: "cancelado",
} as const;

export type OrderPaymentStatus =
  (typeof ORDER_PAYMENT_STATUS)[keyof typeof ORDER_PAYMENT_STATUS];

interface MarkOrderPaidInput {
  orderId: string;
  /** Id da cobrança no Asaas (gravado quando ainda não estava no pedido). */
  paymentId?: string | null;
  /** Momento da confirmação (ISO). Padrão: agora. */
  confirmedAt?: string | null;
}

/**
 * Marca o pedido como pago.
 *
 * Idempotente: o UPDATE só acontece enquanto `payment_status` NÃO é `pago`
 * (reenvios do webhook não geram novas escritas). Devolve `true` quando esta
 * chamada foi a que efetivamente mudou o estado — útil para log/telemetria.
 */
export async function markOrderPaid(
  admin: SupabaseClient,
  input: MarkOrderPaidInput
): Promise<boolean> {
  const orderId = input.orderId?.trim();
  if (!orderId) return false;

  const fields: Record<string, unknown> = {
    payment_status: ORDER_PAYMENT_STATUS.paid,
    payment_confirmed_at: input.confirmedAt ?? new Date().toISOString(),
  };
  if (input.paymentId) fields.asaas_payment_id = input.paymentId;

  const { data, error } = await admin
    .from("orders")
    .update(fields)
    .eq("id", orderId)
    .neq("payment_status", ORDER_PAYMENT_STATUS.paid)
    .select("id");

  if (error) {
    // Base sem a migração 20261110000028: não há como registrar o pagamento.
    console.error(
      `[orderPayments] falha ao marcar o pedido ${orderId} como pago`,
      error
    );
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

/** Marca o pedido como expirado (QR Code vencido sem pagamento). */
export async function markOrderPaymentExpired(
  admin: SupabaseClient,
  orderId: string
): Promise<void> {
  const id = orderId?.trim();
  if (!id) return;

  const { error } = await admin
    .from("orders")
    .update({ payment_status: ORDER_PAYMENT_STATUS.expired })
    .eq("id", id)
    .eq("payment_status", ORDER_PAYMENT_STATUS.pending);

  if (error) {
    console.error(`[orderPayments] falha ao expirar o pagamento ${id}`, error);
  }
}
