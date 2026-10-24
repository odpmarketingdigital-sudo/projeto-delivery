import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";
import {
  getMonthlyPlanPrice,
  isSystemSettingsMissing,
  saveMonthlyPlanPrice,
} from "@/lib/settings";
import {
  MAX_PLAN_PRICE_CENTS,
  MIN_PLAN_PRICE_CENTS,
  formatCentsInput,
  isValidPlanPriceCents,
  parseBRLToCents,
} from "@/lib/subscriptions";

/**
 * GET/POST /api/admin/settings — configurações globais da plataforma.
 *
 * Exclusivo do Super Admin (`requireSuperAdmin`). Hoje gerencia o preço mensal
 * do Plano Profissional, persistido em `public.system_settings` com a chave
 * `monthly_plan_price` (migração 20261110000013).
 *
 * GET  → `{ priceCents, priceLabel, priceInput, source, schemaPending }`
 * POST → Body `{ monthly_plan_price: "97,00" }` (reais) ou `{ priceCents: 9700 }`
 *
 * O preço é lido em tempo de execução pelo checkout e pela tela de assinatura;
 * mudanças valem para as PRÓXIMAS assinaturas (as já criadas no Asaas mantêm o
 * valor contratado).
 */

/** Corpo aceito no POST (valores opcionais para permitir uma mensagem clara). */
interface SettingsBody {
  monthly_plan_price?: unknown;
  price_cents?: unknown;
  priceCents?: unknown;
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Resposta com o preço vigente (usada pelo GET e pelo POST). */
async function priceResponse(message?: string) {
  const pricing = await getMonthlyPlanPrice();

  return NextResponse.json({
    priceCents: pricing.priceCents,
    priceLabel: pricing.priceLabel,
    // Valor pronto para o input do formulário (ex.: "97,00").
    priceInput: formatCentsInput(pricing.priceCents),
    source: pricing.source,
    schemaPending: pricing.schemaPending,
    ...(message ? { message } : {}),
  });
}

/**
 * Converte o corpo da requisição em centavos.
 *
 * `priceCents`/`price_cents` são interpretados como centavos;
 * `monthly_plan_price` como reais (número ou texto com vírgula/ponto).
 */
function readPriceCents(body: SettingsBody): number | null {
  for (const rawCents of [body.priceCents, body.price_cents]) {
    if (typeof rawCents === "number" && Number.isFinite(rawCents)) {
      const cents = Math.round(rawCents);
      return isValidPlanPriceCents(cents) ? cents : null;
    }
  }

  const raw = body.monthly_plan_price;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const cents = Math.round(raw * 100);
    return isValidPlanPriceCents(cents) ? cents : null;
  }

  if (typeof raw === "string") {
    const cents = parseBRLToCents(raw);
    return cents !== null && isValidPlanPriceCents(cents) ? cents : null;
  }

  return null;
}

/** Mensagem de erro do Supabase/JS sem expor detalhes internos ao cliente. */
function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return error instanceof Error ? error.message : "";
}

/** GET — preço vigente do plano. */
export async function GET() {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode ver as configurações da plataforma."
  );
  if (!guard.ok) return guard.response;

  return priceResponse();
}

/** POST — atualiza o preço mensal do plano. */
export async function POST(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode alterar as configurações da plataforma."
  );
  if (!guard.ok) return guard.response;

  let body: SettingsBody;
  try {
    body = (await request.json()) as SettingsBody;
  } catch {
    return fail("Corpo da requisição inválido (JSON esperado).", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Corpo da requisição inválido.", 400);
  }

  const priceCents = readPriceCents(body);

  if (priceCents === null) {
    return fail(
      `Informe um preço mensal válido (entre ${formatCentsInput(
        MIN_PLAN_PRICE_CENTS
      )} e ${formatCentsInput(MAX_PLAN_PRICE_CENTS)} reais).`,
      400
    );
  }

  try {
    await saveMonthlyPlanPrice(priceCents, guard.user.id);
  } catch (error) {
    const message = errorMessage(error);

    if (isSystemSettingsMissing({ message })) {
      return fail(
        "A tabela de configurações ainda não existe no banco. Execute a " +
          "migração 20261110000013_create_system_settings.sql no SQL Editor " +
          "do Supabase.",
        500
      );
    }

    console.error("[admin/settings] falha ao salvar o preço do plano", error);
    return fail("Não foi possível salvar o preço do plano. Tente novamente.", 500);
  }

  return priceResponse("Preço do plano atualizado com sucesso.");
}
