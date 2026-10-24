/**
 * Configurações globais da plataforma (`public.system_settings`).
 *
 * Server-side apenas: usa a service role key (bypass de RLS) para ler/gravar
 * parâmetros que não pertencem a uma loja. Nunca importe este módulo em um
 * Client Component — as telas consomem as rotas `/api/admin/settings` e
 * `/api/billing/plan`.
 *
 * Chave usada hoje:
 *  - `monthly_plan_price` → `{ amount_cents, currency }` (default R$ 97,00)
 *
 * Sempre que a tabela/linha não existir (migração 20261110000013 pendente),
 * o valor padrão de `lib/subscriptions.ts` é devolvido — o checkout continua
 * funcionando enquanto a migração não é aplicada.
 */

import { createAdminClient } from "@/lib/supabase/server";
import {
  DEFAULT_PLAN_PRICE_CENTS,
  buildSubscriptionPlan,
  formatBRL,
  isValidPlanPriceCents,
  parseBRLToCents,
  type SubscriptionPlan,
} from "@/lib/subscriptions";

/** Tabela dos parâmetros globais (migração 20261110000013). */
export const SYSTEM_SETTINGS_TABLE = "system_settings";

/** Chave do preço mensal do Plano Profissional. */
export const MONTHLY_PLAN_PRICE_KEY = "monthly_plan_price";

/** Descrição gravada junto da chave (ajuda quem olha a tabela direto). */
const MONTHLY_PLAN_PRICE_DESCRIPTION =
  "Preço mensal do Plano Profissional, em centavos (9700 = R$ 97,00).";

/**
 * Preço vigente do plano.
 * `source` indica se o valor veio do banco ou do fallback; `schemaPending`
 * sinaliza que a tabela de configurações ainda não existe.
 */
export interface MonthlyPlanPrice {
  priceCents: number;
  priceLabel: string;
  source: "database" | "default";
  schemaPending: boolean;
}

/** Preço padrão (R$ 97,00) no mesmo formato da leitura do banco. */
export function defaultMonthlyPlanPrice(): MonthlyPlanPrice {
  return {
    priceCents: DEFAULT_PLAN_PRICE_CENTS,
    priceLabel: formatBRL(DEFAULT_PLAN_PRICE_CENTS),
    source: "default",
    schemaPending: false,
  };
}

/**
 * Extrai o preço em centavos do `value` (jsonb) gravado em `system_settings`.
 *
 * Formatos aceitos:
 *  - `{ amount_cents: 9700, currency: "BRL" }` (formato canônico);
 *  - `{ price_cents: 9700 }` (compatibilidade);
 *  - número solto (9700 → centavos);
 *  - string "9700" (centavos) ou "97.00"/"97,00" (reais).
 *
 * Retorna `null` quando o valor é inválido — o chamador usa o fallback.
 */
export function readPriceCentsFromSetting(value: unknown): number | null {
  if (typeof value === "number") {
    const cents = Math.round(value);
    return isValidPlanPriceCents(cents) ? cents : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // String só de dígitos = centavos; com separador decimal = reais.
    if (/^\d+$/.test(trimmed)) {
      const cents = Number.parseInt(trimmed, 10);
      return isValidPlanPriceCents(cents) ? cents : null;
    }

    const parsed = parseBRLToCents(trimmed);
    return parsed !== null && isValidPlanPriceCents(parsed) ? parsed : null;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const amount = record.amount_cents ?? record.price_cents;
    return readPriceCentsFromSetting(amount);
  }

  return null;
}

/** `true` quando o erro indica que `system_settings` ainda não foi criada. */
function isMissingSystemSettings(error: { message?: string | null }): boolean {
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("system_settings") &&
    (message.includes("does not exist") ||
      message.includes("could not find the table") ||
      message.includes("schema cache"))
  );
}

/** `true` quando o erro do Supabase indica a migração de settings pendente. */
export function isSystemSettingsMissing(error: {
  message?: string | null;
}): boolean {
  return isMissingSystemSettings(error);
}

/**
 * Lê o preço mensal do plano em `system_settings`.
 *
 * Nunca lança: falha de rede, service role ausente ou migração pendente caem
 * no preço padrão (R$ 97,00), garantindo que o checkout continue operando.
 */
export async function getMonthlyPlanPrice(): Promise<MonthlyPlanPrice> {
  try {
    const adminClient = createAdminClient();

    const { data, error } = await adminClient
      .from(SYSTEM_SETTINGS_TABLE)
      .select("value")
      .eq("key", MONTHLY_PLAN_PRICE_KEY)
      .maybeSingle();

    if (error) {
      if (isMissingSystemSettings(error)) {
        return { ...defaultMonthlyPlanPrice(), schemaPending: true };
      }

      console.error("[settings] falha ao ler o preço do plano", error);
      return defaultMonthlyPlanPrice();
    }

    const priceCents = readPriceCentsFromSetting(
      (data as { value?: unknown } | null)?.value
    );

    if (priceCents === null) {
      // Linha ausente ou valor corrompido: o painel mostra o padrão e o
      // Super Admin pode salvar um valor válido na tela de configurações.
      return defaultMonthlyPlanPrice();
    }

    return {
      priceCents,
      priceLabel: formatBRL(priceCents),
      source: "database",
      schemaPending: false,
    };
  } catch (error) {
    console.error("[settings] erro inesperado ao ler o preço do plano", error);
    return defaultMonthlyPlanPrice();
  }
}

/** Plano do autoatendimento com o preço vigente (fallback incluído). */
export async function getSubscriptionPlan(): Promise<SubscriptionPlan> {
  const pricing = await getMonthlyPlanPrice();
  return buildSubscriptionPlan(pricing.priceCents);
}

/**
 * Grava o preço mensal do plano (centavos) em `system_settings`.
 *
 * Lança o erro do Supabase para a rota responder 500 com a mensagem correta;
 * a validação de faixa é feita pelo chamador (`isValidPlanPriceCents`).
 */
export async function saveMonthlyPlanPrice(
  priceCents: number,
  updatedBy?: string | null
): Promise<void> {
  const adminClient = createAdminClient();

  const { error } = await adminClient.from(SYSTEM_SETTINGS_TABLE).upsert(
    {
      key: MONTHLY_PLAN_PRICE_KEY,
      value: { amount_cents: priceCents, currency: "BRL" },
      description: MONTHLY_PLAN_PRICE_DESCRIPTION,
      updated_by: updatedBy ?? null,
    },
    { onConflict: "key" }
  );

  if (error) throw error;
}

