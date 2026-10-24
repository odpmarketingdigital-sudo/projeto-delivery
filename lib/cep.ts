import { parseCep, toFiniteNumber, type GeoPoint } from "@/lib/delivery";

/**
 * Resolução de CEP para o checkout/painel.
 *
 * Estratégia sem chave de API:
 *  1. BrasilAPI `/api/cep/v2` — endereço e coordenadas de fallback;
 *  2. ViaCEP — fallback de endereço quando a BrasilAPI falha;
 *  3. Nominatim (OpenStreetMap) — priorizado para obter coordenadas de rua,
 *     pois as da BrasilAPI v2 podem ser apenas o centroide da cidade.
 *
 * Todas as chamadas têm timeout curto e falham de forma silenciosa (`null`):
 * uma indisponibilidade externa nunca deve derrubar o checkout.
 */

export interface CepAddress {
  cep: string;
  street: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  source: "brasilapi" | "viacep";
}

interface BrasilApiResponse {
  cep?: string;
  state?: string;
  city?: string;
  neighborhood?: string;
  street?: string;
  location?: {
    coordinates?: {
      longitude?: unknown;
      latitude?: unknown;
    };
  };
}

interface ViaCepResponse {
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  erro?: boolean | string;
}

const REQUEST_TIMEOUT_MS = 6000;

/**
 * Cache em memória (por instância do servidor) para evitar repetir chamadas
 * externas a cada cotação. CEPs e endereços não mudam com frequência.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cepCache = new Map<string, { value: CepAddress; expiresAt: number }>();
const geocodeCache = new Map<string, { value: GeoPoint; expiresAt: number }>();

function readCache<T>(
  cache: Map<string, { value: T; expiresAt: number }>,
  key: string
): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache<T>(
  cache: Map<string, { value: T; expiresAt: number }>,
  key: string,
  value: T
): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        // Nominatim exige um User-Agent identificável.
        "User-Agent": "IpepperDelivery/1.0 (delivery checkout)",
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Intervalo mínimo entre chamadas ao Nominatim (política de uso: 1 req/s). */
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let geocodeQueue: Promise<void> = Promise.resolve();
let lastGeocodeStartedAt = 0;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function geocodeAddress(address: string): Promise<GeoPoint | null> {
  const query = address.trim();
  if (!query) return null;

  const cacheKey = query.toLowerCase();
  const cached = readCache(geocodeCache, cacheKey);
  if (cached) return cached;

  const run = async (): Promise<GeoPoint | null> => {
    const wait = Math.max(
      0,
      NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastGeocodeStartedAt)
    );
    if (wait > 0) await sleep(wait);
    lastGeocodeStartedAt = Date.now();

    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?format=jsonv2&limit=1&countrycodes=br&q=${encodeURIComponent(query)}`;

    const data = await fetchJson<Array<{ lat?: string; lon?: string }>>(url);
    const first = Array.isArray(data) ? data[0] : null;
    if (!first) return null;

    const latitude = toFiniteNumber(first.lat);
    const longitude = toFiniteNumber(first.lon);
    if (latitude == null || longitude == null) return null;
    if (latitude === 0 && longitude === 0) return null;

    const point = { latitude, longitude };
    writeCache(geocodeCache, cacheKey, point);
    return point;
  };

  // Serializa as consultas para respeitar o limite do Nominatim.
  const result = geocodeQueue.then(run, run);
  geocodeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function buildAddressQuery(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join(", ");
}

/**
 * Geocodifica um endereço de CEP priorizando o Nominatim.
 *
 * A BrasilAPI v2 costuma devolver coordenadas de centroide da cidade para
 * vários CEPs diferentes. Se usarmos esse ponto para origem e destino, a
 * distância calculada fica `0`. Por isso a primeira tentativa é sempre o
 * endereço estruturado no Nominatim; o CEP puro e as coordenadas da BrasilAPI
 * ficam como fallback.
 */
async function resolveCepCoordinates(address: {
  street: string | null;
  city: string | null;
  state: string | null;
  cep: string;
}): Promise<GeoPoint | null> {
  const queries = [
    buildAddressQuery([
      address.street,
      address.city,
      address.state,
      address.cep,
      "Brasil",
    ]),
    buildAddressQuery([address.street, address.city, address.state, "Brasil"]),
    buildAddressQuery([address.cep, "Brasil"]),
  ];

  const seen = new Set<string>();
  for (const query of queries) {
    if (!query || seen.has(query)) continue;
    seen.add(query);
    const point = await geocodeAddress(query);
    if (point) return point;
  }

  return null;
}

/**
 * Busca endereço e coordenadas de um CEP.
 * Retorna `null` quando o CEP é inválido, não existe ou as APIs estão fora.
 */
export async function lookupCep(rawCep: unknown): Promise<CepAddress | null> {
  const cep = parseCep(rawCep);
  if (!cep) return null;

  const cached = readCache(cepCache, cep);
  if (cached) return cached;

  const remember = (address: CepAddress): CepAddress => {
    writeCache(cepCache, cep, address);
    return address;
  };

  const brasilApi = await fetchJson<BrasilApiResponse>(
    `https://brasilapi.com.br/api/cep/v2/${cep}`
  );

  if (brasilApi && (brasilApi.cep || brasilApi.city || brasilApi.street)) {
    const street = clean(brasilApi.street);
    const neighborhood = clean(brasilApi.neighborhood);
    const city = clean(brasilApi.city);
    const state = clean(brasilApi.state);

    // Coordenadas da BrasilAPI: usadas apenas se o Nominatim não resolver o
    // endereço. Em muitos municípios elas são o centroide da cidade e não a
    // rua do CEP — o que zeraria a distância quando origem e destino usam a
    // mesma fonte.
    let fallbackLatitude = toFiniteNumber(
      brasilApi.location?.coordinates?.latitude
    );
    let fallbackLongitude = toFiniteNumber(
      brasilApi.location?.coordinates?.longitude
    );
    if (fallbackLatitude === 0 && fallbackLongitude === 0) {
      fallbackLatitude = null;
      fallbackLongitude = null;
    }

    const point = await resolveCepCoordinates({ street, city, state, cep });
    const latitude = point?.latitude ?? fallbackLatitude;
    const longitude = point?.longitude ?? fallbackLongitude;

    return remember({
      cep: parseCep(brasilApi.cep) ?? cep,
      street,
      neighborhood,
      city,
      state,
      latitude,
      longitude,
      source: "brasilapi",
    });
  }

  const viaCep = await fetchJson<ViaCepResponse>(
    `https://viacep.com.br/ws/${cep}/json/`
  );

  if (viaCep && !viaCep.erro) {
    const street = clean(viaCep.logradouro);
    const neighborhood = clean(viaCep.bairro);
    const city = clean(viaCep.localidade);
    const state = clean(viaCep.uf);

    const point = await resolveCepCoordinates({ street, city, state, cep });

    return remember({
      cep: parseCep(viaCep.cep) ?? cep,
      street,
      neighborhood,
      city,
      state,
      latitude: point?.latitude ?? null,
      longitude: point?.longitude ?? null,
      source: "viacep",
    });
  }

  return null;
}
