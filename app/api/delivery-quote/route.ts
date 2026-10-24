import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { quoteDelivery } from "@/lib/deliveryQuote";

/**
 * POST /api/delivery-quote
 *
 * Pré-visualização pública da taxa de entrega usada pelo checkout.
 * A taxa NUNCA deve ser calculada apenas no navegador: `POST /api/orders`
 * revalida os mesmos dados antes de gravar o pedido.
 *
 * Body: { establishment_id: string; cep?: string }
 */
export async function POST(request: Request) {
  type QuoteBody = { establishment_id?: unknown; cep?: unknown };
  let body: QuoteBody;
  try {
    body = (await request.json()) as QuoteBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const establishmentId =
    typeof body.establishment_id === "string"
      ? body.establishment_id.trim()
      : "";
  if (!establishmentId) {
    return NextResponse.json(
      { error: "Informe o estabelecimento." },
      { status: 400 }
    );
  }

  const cep = typeof body.cep === "string" ? body.cep : null;

  const adminClient = createAdminClient();
  const { data: establishment, error } = await adminClient
    .from("establishments")
    .select("*")
    .eq("id", establishmentId)
    .eq("status", "ativo")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: "Não foi possível carregar a loja." },
      { status: 500 }
    );
  }
  if (!establishment) {
    return NextResponse.json(
      { error: "Estabelecimento não encontrado ou inativo." },
      { status: 404 }
    );
  }

  const result = await quoteDelivery(establishment, cep);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // `distance_km` também no nível raiz: facilita consumidores que só precisam
  // da distância. É sempre um float (ex.: 3.42) ou `null` quando não foi
  // possível calcular — nunca `0`.
  return NextResponse.json(
    {
      distance_km: result.quote.distance_km,
      quote: result.quote,
    },
    { status: 200 }
  );
}
