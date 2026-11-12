/**
 * Regras de cupom que dependem do banco (server-side).
 *
 * O módulo `lib/coupons.ts` é puro e compartilhado com o checkout; aqui ficam
 * apenas as consultas usadas pelas rotas de API (`/api/coupons/validate` e
 * `POST /api/orders`) para validar a regra de "apenas no primeiro pedido".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCouponPhone } from "@/lib/coupons";

/** Telefone mínimo aceito (DDD + número) para identificar o cliente. */
export const COUPON_PHONE_MIN_DIGITS = 10;

export interface PreviousOrderCheckInput {
  establishmentId: string;
  phone: unknown;
}

/**
 * Indica se o cliente já possui pedidos anteriores (não cancelados) na loja.
 *
 * `orders.customer_phone` é gravado somente com dígitos por `POST /api/orders`,
 * mas bases legadas podem ter o telefone formatado — por isso existe o fallback
 * por trecho de dígitos. Cancelados não contam como pedido anterior (o cliente
 * continua elegível ao cupom de primeira compra).
 */
export async function customerHasPreviousOrders(
  admin: SupabaseClient,
  input: PreviousOrderCheckInput
): Promise<boolean> {
  const phone = normalizeCouponPhone(input.phone);
  if (phone.length < COUPON_PHONE_MIN_DIGITS) return false;

  const { data: exact, error: exactError } = await admin
    .from("orders")
    .select("id")
    .eq("establishment_id", input.establishmentId)
    .eq("customer_phone", phone)
    .neq("status", "cancelado")
    .limit(1);

  if (!exactError && Array.isArray(exact) && exact.length > 0) {
    return true;
  }

  // Fallback: telefone salvo com máscara em pedidos antigos (apenas dígitos na
  // busca, então não há risco de injeção no filtro do PostgREST).
  const { data: formatted, error: formattedError } = await admin
    .from("orders")
    .select("id")
    .eq("establishment_id", input.establishmentId)
    .neq("status", "cancelado")
    .ilike("customer_phone", `%${phone}%`)
    .limit(1);

  if (formattedError) {
    console.error(
      "[coupons] falha ao verificar pedidos anteriores do cliente:",
      formattedError.message
    );
    return false;
  }

  return Array.isArray(formatted) && formatted.length > 0;
}
