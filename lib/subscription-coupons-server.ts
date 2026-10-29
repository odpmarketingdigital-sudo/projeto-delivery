/**
 * Acesso a `public.subscription_coupons` (cupons da assinatura).
 *
 * Server-side apenas: usa a service role key (bypass de RLS) e por isso não
 * deve ser importado em Client Components — as telas consomem
 * `/api/admin/subscription-coupons`, `/api/billing/coupon` e
 * `/api/billing/checkout`.
 *
 * Migração: `20261110000018_create_subscription_coupons.sql`.
 */

import { createAdminClient } from "@/lib/supabase/server";
import {
  normalizeSubscriptionCouponCode,
  type SubscriptionCouponFields,
  type SubscriptionCouponRecord,
} from "@/lib/subscription-coupons";

/** Tabela dos cupons da assinatura. */
export const SUBSCRIPTION_COUPONS_TABLE = "subscription_coupons";

/** Migração que cria a tabela/RPC (usada nas mensagens de erro). */
export const SUBSCRIPTION_COUPONS_MIGRATION =
  "20261110000018_create_subscription_coupons.sql";

/** Colunas lidas pelas rotas (evita depender de `select *`). */
export const SUBSCRIPTION_COUPONS_COLUMNS =
  "id, code, discount_type, discount_value, usage_limit, used_count, active, created_at, updated_at";

/** Erro específico de schema pendente (tabela/RPC ainda não criadas). */
export class SubscriptionCouponsSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionCouponsSchemaError";
  }
}

/** `true` quando o erro indica que `subscription_coupons` ainda não existe. */
export function isMissingSubscriptionCouponsTable(error: {
  message?: string | null;
}): boolean {
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes(SUBSCRIPTION_COUPONS_TABLE) &&
    (message.includes("does not exist") ||
      message.includes("could not find the table") ||
      message.includes("schema cache"))
  );
}

/** Mensagem amigável com a instrução da migração pendente. */
export function subscriptionCouponsSchemaHint(message: string): string {
  if (isMissingSubscriptionCouponsTable({ message })) {
    return (
      "A tabela de cupons da assinatura ainda não existe no banco. " +
      `Execute a migração ${SUBSCRIPTION_COUPONS_MIGRATION} no SQL Editor do Supabase.`
    );
  }
  return message;
}

/** Converte o erro do Supabase em erro tipado (schema pendente × falha real). */
function toSchemaAwareError(error: {
  message?: string | null;
}): SubscriptionCouponsSchemaError | Error {
  const message = error.message ?? "Falha ao acessar os cupons da assinatura.";
  if (isMissingSubscriptionCouponsTable(error)) {
    return new SubscriptionCouponsSchemaError(
      subscriptionCouponsSchemaHint(message)
    );
  }
  return new Error(message);
}

/** Lista todos os cupons (mais recentes primeiro). */
export async function listSubscriptionCoupons(): Promise<{
  coupons: SubscriptionCouponRecord[];
  schemaPending: boolean;
}> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from(SUBSCRIPTION_COUPONS_TABLE)
    .select(SUBSCRIPTION_COUPONS_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingSubscriptionCouponsTable(error)) {
      return { coupons: [], schemaPending: true };
    }
    throw toSchemaAwareError(error);
  }

  return {
    coupons: (data ?? []) as SubscriptionCouponRecord[],
    schemaPending: false,
  };
}

/** Busca um cupom pelo código (normalizado em caixa alta). */
export async function findSubscriptionCouponByCode(
  code: string
): Promise<SubscriptionCouponRecord | null> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from(SUBSCRIPTION_COUPONS_TABLE)
    .select(SUBSCRIPTION_COUPONS_COLUMNS)
    .eq("code", normalizeSubscriptionCouponCode(code))
    .maybeSingle();

  if (error) {
    throw toSchemaAwareError(error);
  }

  return (data as SubscriptionCouponRecord | null) ?? null;
}

/** Busca um cupom pelo id (usado no PATCH/DELETE do Super Admin). */
export async function findSubscriptionCouponById(
  id: string
): Promise<SubscriptionCouponRecord | null> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from(SUBSCRIPTION_COUPONS_TABLE)
    .select(SUBSCRIPTION_COUPONS_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw toSchemaAwareError(error);
  }

  return (data as SubscriptionCouponRecord | null) ?? null;
}

/** Cria um cupom. Devolve o erro tipado para o chamador traduzir. */
export async function createSubscriptionCoupon(
  fields: SubscriptionCouponFields,
  createdBy: string | null = null
): Promise<
  | { coupon: SubscriptionCouponRecord; error: null }
  | { coupon: null; error: Error }
> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from(SUBSCRIPTION_COUPONS_TABLE)
    .insert({ ...fields, created_by: createdBy })
    .select(SUBSCRIPTION_COUPONS_COLUMNS)
    .single();

  if (error || !data) {
    return {
      coupon: null,
      error: error
        ? toSchemaAwareError(error)
        : new Error("Não foi possível criar o cupom."),
    };
  }

  return { coupon: data as SubscriptionCouponRecord, error: null };
}

/** Atualiza um cupom existente (payload completo já validado). */
export async function updateSubscriptionCoupon(
  id: string,
  fields: SubscriptionCouponFields
): Promise<
  | { coupon: SubscriptionCouponRecord; error: null }
  | { coupon: null; error: Error }
> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from(SUBSCRIPTION_COUPONS_TABLE)
    .update(fields)
    .eq("id", id)
    .select(SUBSCRIPTION_COUPONS_COLUMNS)
    .single();

  if (error || !data) {
    return {
      coupon: null,
      error: error
        ? toSchemaAwareError(error)
        : new Error("Cupom não encontrado."),
    };
  }

  return { coupon: data as SubscriptionCouponRecord, error: null };
}

/** Remove um cupom. */
export async function deleteSubscriptionCoupon(
  id: string
): Promise<{ error: Error | null }> {
  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from(SUBSCRIPTION_COUPONS_TABLE)
    .delete()
    .eq("id", id);

  return { error: error ? toSchemaAwareError(error) : null };
}

/**
 * Incrementa `used_count` de forma atômica (RPC
 * `consume_subscription_coupon_usage`) e informa se o uso foi contabilizado.
 *
 * Nunca lança: falha aqui não deve desfazer uma assinatura já criada no Asaas.
 */
export async function consumeSubscriptionCouponUsage(
  id: string
): Promise<boolean> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient.rpc(
    "consume_subscription_coupon_usage",
    { p_coupon_id: id }
  );

  if (error) {
    console.warn(
      `[subscription-coupons] falha ao contabilizar o cupom ${id}:`,
      error.message
    );
    return false;
  }

  return data === true;
}
