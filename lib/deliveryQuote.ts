import { lookupCep, type CepAddress } from "@/lib/cep";
import {
  buildDeliveryQuote,
  haversineDistanceKm,
  normalizeDeliverySettings,
  parseCep,
  type DeliveryQuote,
} from "@/lib/delivery";

/**
 * Cotação de entrega no servidor (fonte da verdade).
 *
 * Usada por `POST /api/delivery-quote` (pré-visualização no checkout) e por
 * `POST /api/orders` (revalidação antes de gravar o pedido).
 */

export interface DeliveryQuotePayload extends DeliveryQuote {
  /** CEP normalizado (somente dígitos) usado na cotação. */
  cep: string | null;
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

export async function quoteDelivery(
  establishmentRow: unknown,
  rawCep?: string | null
): Promise<DeliveryQuoteResult> {
  const settings = normalizeDeliverySettings(establishmentRow);
  const rawValue = typeof rawCep === "string" ? rawCep.trim() : "";
  const cep = parseCep(rawValue);
  const needsCep =
    settings.delivery_type === "distance" ||
    settings.max_delivery_radius_km != null;

  if (rawValue && !cep) {
    return {
      ok: false,
      status: 400,
      error: "CEP inválido. Informe os 8 dígitos do CEP.",
    };
  }

  if (!cep && needsCep) {
    return {
      ok: false,
      status: 400,
      error:
        settings.delivery_type === "distance"
          ? "Informe o CEP do endereço de entrega para calcular a taxa por distância."
          : "Informe o CEP do endereço de entrega para validar o raio de entrega.",
    };
  }

  // Endereço/coordenadas só são necessários quando há cálculo por distância ou
  // validação de raio. No modelo fixo sem raio, evitamos chamadas externas:
  // a taxa já é conhecida e o pedido não depende da geocodificação.
  let address: CepAddress | null = null;
  if (cep && needsCep) {
    address = await lookupCep(cep);
    if (!address) {
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
  if (settings.store_cep && needsCep) {
    storeAddress = await lookupCep(settings.store_cep);
  }

  const storePoint =
    storeAddress?.latitude != null && storeAddress.longitude != null
      ? {
          latitude: storeAddress.latitude,
          longitude: storeAddress.longitude,
        }
      : storedStorePoint;

  const distanceKm =
    storePoint != null &&
    address?.latitude != null &&
    address?.longitude != null
      ? haversineDistanceKm(storePoint, {
          latitude: address.latitude,
          longitude: address.longitude,
        })
      : null;

  const quote = buildDeliveryQuote(settings, distanceKm);
  const warnings: string[] = [];

  if (settings.delivery_type === "distance" && quote.fee_source === "fixed_fallback") {
    warnings.push(
      storePoint == null
        ? "A loja ainda não configurou a localização de origem. A taxa fixa foi aplicada."
        : "Não foi possível calcular a distância até o endereço. A taxa fixa foi aplicada."
    );
  }

  if (
    settings.max_delivery_radius_km != null &&
    distanceKm == null &&
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
