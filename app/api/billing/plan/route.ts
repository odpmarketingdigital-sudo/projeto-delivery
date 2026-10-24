import { NextResponse } from "next/server";
import { getMonthlyPlanPrice } from "@/lib/settings";

/**
 * GET /api/billing/plan — preço vigente do Plano Profissional.
 *
 * Público (o preço já aparece no card de assinatura e na landing page): a tela
 * `/painel/assinatura` usa esta rota para exibir o valor salvo pelo Super Admin
 * em `system_settings` e, se a leitura falhar, mantém o fallback local
 * (`IPEPPER_PRO_PLAN`, R$ 97,00).
 *
 * Resposta: `{ priceCents, priceLabel, period, source, schemaPending }`.
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
      source: pricing.source,
      schemaPending: pricing.schemaPending,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
