import { NextResponse } from "next/server";
import { getMonthlyPlanPrice } from "@/lib/settings";
import { buildBillingCyclePrices } from "@/lib/subscriptions";

/**
 * GET /api/billing/plan — preço vigente do Plano Profissional.
 *
 * Público (o preço já aparece no card de assinatura e na landing page): a tela
 * `/painel/assinatura` usa esta rota para exibir o valor salvo pelo Super Admin
 * em `system_settings` e, se a leitura falhar, mantém o fallback local
 * (`IPEPPER_PRO_PLAN`, R$ 97,00).
 *
 * Resposta:
 * `{ priceCents, priceLabel, period, cycles, source, schemaPending }`, onde
 * `cycles` traz mensal, semestral (−5%) e anual (−10%) já calculados.
 * `Cache-Control: no-store` para que uma alteração no painel apareça no
 * próximo carregamento.
 */
export async function GET() {
  const pricing = await getMonthlyPlanPrice();

  return NextResponse.json(
    {
      priceCents: pricing.priceCents,
      priceLabel: pricing.priceLabel,
      period: "mês",
      cycles: buildBillingCyclePrices(pricing.priceCents),
      source: pricing.source,
      schemaPending: pricing.schemaPending,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
