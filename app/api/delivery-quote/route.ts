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
 * A distância vem da Google Routes API (rota real, com trânsito) quando a
 * chave `GOOGLE_MAPS_API_KEY` está configurada; sem ela, a cotação responde
 * com a distância em linha reta e `distance_source = "haversine"`.
 *
 * **Precisão obrigatória:** para o modelo por km, o destino precisa estar no
 * nível do número — coordenadas do autocomplete (`latitude`/`longitude`) ou um
 * geocode que comprove o número. Sem isso a rota devolve `422` em vez de cobrar
 * um valor calculado a partir do centroide da rua (distâncias irreais, como
 * 1,4 km para um endereço a 13,4 km).
 *
 * Body: {
 *   establishment_id: string;
 *   latitude?: number;   // coordenadas do Places Autocomplete (preferido)
 *   longitude?: number;
 *   place_id?: string;
 *   cep?: string;        // legado: clientes antigos que ainda enviam o CEP
 *   address?: { street, number, neighborhood, city, state, cep };
 * }
 */
export async function POST(request: Request) {
  type QuoteBody = {
    establishment_id?: unknown;
    cep?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    place_id?: unknown;
    /** Endereço digitado (rua/número/bairro/cidade) quando não há Places/CEP. */
    address?: unknown;
  };
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
  // `latitude`/`longitude` são normalizadas por `parseGeoPoint` dentro da
  // cotação; aqui só repassamos os valores crus para aceitar number ou string.
  const placeId =
    typeof body.place_id === "string" && body.place_id.trim()
      ? body.place_id.trim()
      : null;

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

  const result = await quoteDelivery(establishment, {
    cep,
    latitude: body.latitude,
    longitude: body.longitude,
    place_id: placeId,
    address:
      body.address && typeof body.address === "object"
        ? (body.address as Record<string, unknown>)
        : null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // `distance_km`/`duration_minutes` também no nível raiz: facilita
  // consumidores que só precisam da distância/tempo. Distância é sempre um
  // float (ex.: 3.42) ou `null` quando não foi possível calcular — nunca `0`.
  return NextResponse.json(
    {
      distance_km: result.quote.distance_km,
      duration_minutes: result.quote.duration_minutes,
      distance_source: result.quote.distance_source,
      quote: result.quote,
    },
    { status: 200 }
  );
}
