import {
  geocodeAddressNumberExact,
  geocodeStoreAddress,
  lookupCep,
  type AddressParts,
  type CepAddress,
} from "@/lib/cep";
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
import { geocodeAddressExactWithGoogle } from "@/lib/googleGeocoding";

/**
 * Cotação de entrega no servidor (fonte da verdade).
 *
 * Usada por `POST /api/delivery-quote` (pré-visualização no checkout) e por
 * `POST /api/orders` (revalidação antes de gravar o pedido).
 *
 * A distância vem da **Google Routes API** (rota real de carro, com trânsito);
 * sem chave configurada ou em caso de falha, cai para a distância em linha
 * reta (Haversine) e a cotação sinaliza `distance_source = "haversine"`.
 *
 * A posição do cliente tem de ser **exata** (nível de número): coordenadas do
 * autocomplete do Google ou um geocode que comprove o número. Centroides de
 * rua/cidade são recusados — eles produzem distâncias irreais (ex.: 1,4 km para
 * um endereço a 13,4 km) e, por consequência, frete errado.
 */

/**
 * Precisão da posição do cliente usada no cálculo.
 *  - `places`: coordenadas do autocomplete (Google Places) — nível de porta;
 *  - `geocoded_number`: geocode por endereço com número comprovado;
 *  - `cep`: coordenadas do CEP (nível de rua, apenas legado).
 */
export type DestinationPrecision = "places" | "geocoded_number" | "cep";

/** Destino informado pelo cliente (coordenadas do Places, CEP ou endereço). */
export interface DeliveryDestination {
  cep?: string | null;
  /** Latitude vinda do autocomplete (pode chegar como string do JSON). */
  latitude?: unknown;
  /** Longitude vinda do autocomplete (pode chegar como string do JSON). */
  longitude?: unknown;
  /** `place_id` do Google — gravado no pedido para auditoria. */
  place_id?: string | null;
  /**
   * Endereço digitado no checkout (rua/número/bairro/cidade). O cliente não
   * digita mais o CEP: sem coordenadas do Places nem CEP, o servidor
   * geocodifica estas partes para calcular a rota.
   */
  address?: AddressParts | null;
}

export interface DeliveryQuotePayload extends DeliveryQuote {
  /** CEP normalizado (somente dígitos) usado na cotação. */
  cep: string | null;
  /** Coordenadas efetivamente usadas como destino do cálculo. */
  destination: {
    latitude: number | null;
    longitude: number | null;
    place_id: string | null;
    /** Como a posição foi obtida (`null` quando não houve cálculo). */
    precision: DestinationPrecision | null;
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

/**
 * Lê as partes do endereço enviadas pelo checkout.
 *
 * Retorna `null` quando não há rua — abaixo disso não há endereço utilizável
 * para geocodificar.
 */
function normalizeAddressParts(raw: unknown): AddressParts | null {
  if (!raw || typeof raw !== "object") return null;

  const record = raw as Record<string, unknown>;
  const read = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  const parts: AddressParts = {
    street: read(record.street),
    number: read(record.number),
    neighborhood: read(record.neighborhood),
    city: read(record.city),
    state: read(record.state),
    cep: read(record.cep),
  };

  return parts.street ? parts : null;
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
  // Endereço digitado no checkout — usado quando não há coordenadas do Places
  // nem CEP (o cliente final não digita mais o CEP).
  const requestedAddress = normalizeAddressParts(destination.address);
  // Precisão da posição do cliente. As coordenadas do autocomplete já chegam
  // no nível da porta (`places`); um geocode só entra se comprovar o número.
  let precision: DestinationPrecision | null = clientPoint ? "places" : null;

  if (rawCepValue && !cep && !clientPoint) {
    return {
      ok: false,
      status: 400,
      error: "CEP inválido. Informe os 8 dígitos do CEP.",
    };
  }

  if (!cep && !clientPoint && needsGeo && !requestedAddress) {
    return {
      ok: false,
      status: 400,
      error:
        settings.delivery_type === "distance"
          ? "Informe o endereço de entrega para calcular a taxa por distância."
          : "Informe o endereço de entrega para validar o raio de entrega.",
    };
  }

  // Sem coordenadas do Places: geocodifica o endereço digitado exigindo o
  // número exato (Google Geocoding → Nominatim estruturado). Centroides de
  // rua/cidade **nunca** são aceitos — são a origem das distâncias irreais.
  let geocodedPoint: GeoPoint | null = null;
  if (!clientPoint && needsGeo && requestedAddress) {
    geocodedPoint =
      (await geocodeAddressExactWithGoogle({
        street: requestedAddress.street ?? null,
        number: requestedAddress.number ?? null,
        neighborhood: requestedAddress.neighborhood ?? null,
        city: requestedAddress.city ?? null,
        state: requestedAddress.state ?? null,
        cep: requestedAddress.cep ?? null,
      })) ?? (await geocodeAddressNumberExact(requestedAddress));
    if (geocodedPoint) precision = "geocoded_number";
  }

  // Endereço/coordenadas só são necessários quando há cálculo por distância ou
  // validação de raio. No modelo fixo sem raio, evitamos chamadas externas:
  // a taxa já é conhecida e o pedido não depende da geocodificação.
  let address: CepAddress | null = null;
  if (cep && needsGeo) {
    address = await lookupCep(cep);
    // Com coordenadas do navegador — ou com o endereço já geocodificado com
    // número — a cotação segue mesmo se o CEP falhar: a distância não depende
    // dele.
    if (!address && !clientPoint && !geocodedPoint) {
      return {
        ok: false,
        status: 400,
        error:
          "Não encontramos esse CEP. Confira os dígitos e tente novamente.",
      };
    }
  }

  // Origem do frete: as coordenadas confirmadas pela API de endereços no painel
  // (`/api/geocode` → `PUT /api/establishment` grava `store_latitude` e
  // `store_longitude`). Elas são a fonte da verdade e **não** são recalculadas
  // aqui: uma nova consulta poderia devolver outro ponto (ex.: centroide do
  // município) e deslocar a origem que o lojista validou.
  // Para lojas sem coordenadas salvas (bases anteriores à origem configurável),
  // geocodificamos o endereço por extenso — ou, na falta dele, o CEP — apenas
  // para manter o cálculo operante.
  let storePoint: GeoPoint | null =
    settings.store_latitude != null && settings.store_longitude != null
      ? {
          latitude: settings.store_latitude,
          longitude: settings.store_longitude,
        }
      : null;

  if (!storePoint && needsGeo) {
    if (settings.store_address) {
      const geocodedStore = await geocodeStoreAddress(settings.store_address);
      if (geocodedStore) {
        storePoint = {
          latitude: geocodedStore.latitude,
          longitude: geocodedStore.longitude,
        };
      }
    }
    if (!storePoint && settings.store_cep) {
      const cepAddress = await lookupCep(settings.store_cep);
      if (cepAddress?.latitude != null && cepAddress.longitude != null) {
        storePoint = {
          latitude: cepAddress.latitude,
          longitude: cepAddress.longitude,
        };
      }
    }
  }

  const cepPoint: GeoPoint | null =
    address?.latitude != null && address.longitude != null
      ? { latitude: address.latitude, longitude: address.longitude }
      : null;

  // Ordem de precedência: Places (porta) → geocode com número → CEP (rua).
  const destinationPoint: GeoPoint | null =
    clientPoint ?? geocodedPoint ?? cepPoint;

  if (destinationPoint && precision == null) precision = "cep";

  // Modelo por distância sem posição exata: recusa a cotação em vez de cobrar
  // um valor calculado a partir de um ponto aproximado (centroide de rua).
  if (!destinationPoint && settings.delivery_type === "distance") {
    return {
      ok: false,
      status: 422,
      error:
        "Não conseguimos confirmar a localização exata deste endereço. Selecione o endereço na lista de sugestões do autocomplete para calcularmos o frete pela rota real.",
    };
  }

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

  // CEP é nível de rua: avisamos quando a distância não veio da porta.
  if (
    settings.delivery_type === "distance" &&
    precision === "cep" &&
    quote.distance_km != null
  ) {
    warnings.push(
      "Distância calculada a partir do CEP (pode variar até o número do endereço)."
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
        precision,
      },
      address: address
        ? {
            street: address.street,
            neighborhood: address.neighborhood,
            city: address.city,
            state: address.state,
          }
        : requestedAddress
          ? {
              street: requestedAddress.street ?? null,
              neighborhood: requestedAddress.neighborhood ?? null,
              city: requestedAddress.city ?? null,
              state: requestedAddress.state ?? null,
            }
          : null,
      warnings,
    },
  };
}
