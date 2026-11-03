import { lookupCep, type CepAddress } from "@/lib/cep";
import {
  buildDeliveryQuote,
  haversineDistanceKm,
  normalizeDeliverySettings,
  parseCep,
  parseGeoPoint,
  roundDistanceKm,
  type DeliveryDistanceSource,
  type DeliveryQuote,
  type GeoPoint,
} from "@/lib/delivery";
import { computeRouteEstimate } from "@/lib/googleRoutes";

/**
 * Cotação de entrega no servidor (fonte da verdade).
 *
 * Usada por `POST /api/delivery-quote` (pré-visualização no checkout) e por
 * `POST /api/orders` (revalidação antes de gravar o pedido).
 *
 * A distância vem da **Google Routes API** (rota real de carro, com trânsito);
 * sem chave configurada ou em caso de falha, cai para a distância em linha
 * reta (Haversine) e a cotação sinaliza `distance_source = "haversine"`.
 */

/** Destino informado pelo cliente (coordenadas do Places ou CEP). */
export interface DeliveryDestination {
  cep?: string | null;
  /** Latitude vinda do autocomplete (pode chegar como string do JSON). */
  latitude?: unknown;
  /** Longitude vinda do autocomplete (pode chegar como string do JSON). */
  longitude?: unknown;
  /** `place_id` do Google — gravado no pedido para auditoria. */
  place_id?: string | null;
}

export interface DeliveryQuotePayload extends DeliveryQuote {
  /** CEP normalizado (somente dígitos) usado na cotação. */
  cep: string | null;
  /** Coordenadas efetivamente usadas como destino do cálculo. */
  destination: {
    latitude: number | null;
    longitude: number | null;
    place_id: string | null;
  };
  address: {
    street: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
  } | null;
  /** Avisos não bloqueantes (ex.: fallback para a taxa fixa). */
  warnings: string[];
}

export type DeliveryQuoteResult =
  | { ok: true; quote: DeliveryQuotePayload }
  | { ok: false; status: number; error: string };

/** Aceita o formato legado (`string` = CEP) e o novo objeto de destino. */
function normalizeDestination(
  raw: DeliveryDestination | string | null | undefined
): DeliveryDestination {
  if (typeof raw === "string") return { cep: raw };
  if (!raw || typeof raw !== "object") return {};
  return raw;
}


export async function quoteDelivery(
  establishmentRow: unknown,
  rawDestination?: DeliveryDestination | string | null
): Promise<DeliveryQuoteResult> {
  const settings = normalizeDeliverySettings(establishmentRow);
  const destination = normalizeDestination(rawDestination);
  const rawCepValue =
    typeof destination.cep === "string" ? destination.cep.trim() : "";
  const cep = parseCep(rawCepValue);
  // Coordenadas do Places Autocomplete: dispensam a consulta de CEP para o
  // cálculo e são mais precisas que o centroide devolvido por APIs de CEP.
  const clientPoint = parseGeoPoint(destination.latitude, destination.longitude);
  const placeId =
    typeof destination.place_id === "string" && destination.place_id.trim()
      ? destination.place_id.trim()
      : null;
  const needsGeo =
    settings.delivery_type === "distance" ||
    settings.max_delivery_radius_km != null;

  if (rawCepValue && !cep && !clientPoint) {
    return {
      ok: false,
      status: 400,
      error: "CEP inválido. Informe os 8 dígitos do CEP.",
    };
  }

  if (!cep && !clientPoint && needsGeo) {
    return {
      ok: false,
      status: 400,
      error:
        settings.delivery_type === "distance"
          ? "Informe o endereço de entrega para calcular a taxa por distância."
          : "Informe o endereço de entrega para validar o raio de entrega.",
    };
  }

  // Endereço/coordenadas só são necessários quando há cálculo por distância ou
  // validação de raio. No modelo fixo sem raio, evitamos chamadas externas:
  // a taxa já é conhecida e o pedido não depende da geocodificação.
  let address: CepAddress | null = null;
  if (cep && needsGeo) {
    address = await lookupCep(cep);
    // Com coordenadas do navegador a cotação segue mesmo se o CEP falhar: a
    // distância não depende dele.
    if (!address && !clientPoint) {
      return {
        ok: false,
        status: 400,
        error:
          "Não encontramos esse CEP. Confira os dígitos e tente novamente.",
      };
    }
  }

  const storedStorePoint =
    settings.store_latitude != null && settings.store_longitude != null
      ? {
          latitude: settings.store_latitude,
          longitude: settings.store_longitude,
        }
      : null;

  // A origem do cálculo é o endereço/CEP configurado no painel. Recalculamos a
  // partir do `store_cep` porque as coordenadas salvas podem ter vindo de um
  // serviço que devolve o centroide da cidade (comum na BrasilAPI v2). Se a
  // consulta falhar, mantemos as coordenadas já persistidas como fallback.
  let storeAddress: CepAddress | null = null;
  if (settings.store_cep && needsGeo) {
    storeAddress = await lookupCep(settings.store_cep);
  }

  const storePoint: GeoPoint | null =
    storeAddress?.latitude != null && storeAddress.longitude != null
      ? {
          latitude: storeAddress.latitude,
          longitude: storeAddress.longitude,
        }
      : storedStorePoint;

  const destinationPoint: GeoPoint | null =
    clientPoint ??
    (address?.latitude != null && address.longitude != null
      ? { latitude: address.latitude, longitude: address.longitude }
      : null);

  // Distância: rota real do Google quando há chave e os dois pontos são
  // conhecidos; senão, linha reta (Haversine) como fallback determinístico.
  let distanceKm: number | null = null;
  let durationMinutes: number | null = null;
  let distanceSource: DeliveryDistanceSource | null = null;

  if (storePoint && destinationPoint) {
    const route = await computeRouteEstimate(storePoint, destinationPoint);
    if (route) {
      distanceKm = route.distanceKm;
      durationMinutes = route.durationMinutes;
      distanceSource = "google_routes";
    } else {
      distanceKm = roundDistanceKm(
        haversineDistanceKm(storePoint, destinationPoint)
      );
      distanceSource = "haversine";
    }
  }

  const quote = buildDeliveryQuote(settings, distanceKm, {
    durationMinutes,
    distanceSource,
  });
  const warnings: string[] = [];

  if (settings.delivery_type === "distance" && quote.fee_source === "fixed_fallback") {
    warnings.push(
      storePoint == null
        ? "A loja ainda não configurou a localização de origem. A taxa fixa foi aplicada."
        : "Não foi possível calcular a distância até o endereço. A taxa fixa foi aplicada."
    );
  }

  if (
    settings.delivery_type === "distance" &&
    distanceSource === "haversine" &&
    quote.distance_km != null
  ) {
    warnings.push(
      "Distância estimada em linha reta (rota do Google indisponível). A taxa pode variar."
    );
  }

  if (
    settings.max_delivery_radius_km != null &&
    quote.distance_km == null &&
    settings.delivery_type !== "distance"
  ) {
    warnings.push(
      "Não foi possível validar o raio de entrega para este endereço."
    );
  }

  return {
    ok: true,
    quote: {
      ...quote,
      cep,
      destination: {
        latitude: destinationPoint?.latitude ?? null,
        longitude: destinationPoint?.longitude ?? null,
        place_id: placeId,
      },
      address: address
        ? {
            street: address.street,
            neighborhood: address.neighborhood,
            city: address.city,
            state: address.state,
          }
        : null,
      warnings,
    },
  };
}
