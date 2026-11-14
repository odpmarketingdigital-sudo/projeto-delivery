import {
  parseCep,
  toFiniteNumber,
  STORE_ADDRESS_MIN_LENGTH,
  type GeoPoint,
} from "@/lib/delivery";

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

/** Resposta do Nominatim (somente os campos usados pela aplicação). */
interface NominatimSearchResult {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    neighbourhood?: string;
    suburb?: string;
    city_district?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    postcode?: string;
  };
}

/** Parâmetros aceitos pela busca do Nominatim. */
interface NominatimSearchParams {
  /** Texto livre (`q`). */
  q?: string;
  /** Consulta estruturada: `<número> <rua>` (com `city`/`state`). */
  street?: string;
  city?: string;
  state?: string;
  /** Máximo de resultados (1 por padrão; a busca por número usa mais). */
  limit?: number;
}

/** Cache da resposta bruta do Nominatim (endereços + coordenadas). */
const placeCache = new Map<
  string,
  { value: NominatimSearchResult[]; expiresAt: number }
>();

function nominatimCacheKey(params: NominatimSearchParams): string {
  return [params.q, params.street, params.city, params.state, params.limit ?? 1]
    .map((part) => (part == null ? "" : String(part).trim().toLowerCase()))
    .join("|");
}

/**
 * Consulta o Nominatim respeitando o limite de 1 req/s.
 *
 * Compartilhada pelo geocode de CEP, pelo endereço extenso (origem do frete) e
 * pela busca por número exato (destino do frete): todas entram na mesma fila,
 * garantindo a política de uso do serviço e aproveitando o mesmo cache.
 *
 * Aceita texto livre (`q`) ou consulta estruturada (`street`/`city`/`state`).
 * A forma estruturada é a única capaz de devolver `house_number` — usada para
 * nunca aceitar o centroide da rua como posição do cliente.
 */
async function searchNominatimResults(
  params: NominatimSearchParams
): Promise<NominatimSearchResult[]> {
  const limit = params.limit ?? 1;
  const search = new URLSearchParams({
    format: "jsonv2",
    addressdetails: "1",
    limit: String(limit),
  });

  const freeText = clean(params.q);
  if (freeText) {
    search.set("q", freeText);
    search.set("countrycodes", "br");
  } else {
    const street = clean(params.street);
    // Sem rua não existe busca estruturada válida.
    if (!street) return [];
    search.set("street", street);
    const city = clean(params.city);
    if (city) search.set("city", city);
    const state = clean(params.state);
    if (state) search.set("state", state);
    search.set("country", "Brasil");
  }

  const cacheKey = nominatimCacheKey(params);
  const cached = readCache(placeCache, cacheKey);
  if (cached) return cached;

  const run = async (): Promise<NominatimSearchResult[]> => {
    const wait = Math.max(
      0,
      NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastGeocodeStartedAt)
    );
    if (wait > 0) await sleep(wait);
    lastGeocodeStartedAt = Date.now();

    const data = await fetchJson<NominatimSearchResult[]>(
      `https://nominatim.openstreetmap.org/search?${search.toString()}`
    );
    const results = Array.isArray(data)
      ? data.filter(
          (row) =>
            toFiniteNumber(row?.lat) != null && toFiniteNumber(row?.lon) != null
        )
      : [];

    writeCache(placeCache, cacheKey, results);
    return results;
  };

  // Serializa as consultas para respeitar o limite do Nominatim.
  const result = geocodeQueue.then(run, run);
  geocodeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Primeiro resultado de uma busca (compatível com o fluxo de CEP/loja). */
async function searchNominatim(
  query: string
): Promise<NominatimSearchResult | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const results = await searchNominatimResults({ q: trimmed });
  return results[0] ?? null;
}

async function geocodeAddress(address: string): Promise<GeoPoint | null> {
  const query = address.trim();
  if (!query) return null;

  const cacheKey = query.toLowerCase();
  const cached = readCache(geocodeCache, cacheKey);
  if (cached) return cached;

  const place = await searchNominatim(query);
  if (!place) return null;

  const latitude = toFiniteNumber(place.lat);
  const longitude = toFiniteNumber(place.lon);
  if (latitude == null || longitude == null) return null;
  if (latitude === 0 && longitude === 0) return null;

  const point = { latitude, longitude };
  writeCache(geocodeCache, cacheKey, point);
  return point;
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
 * Partes de um endereço digitado pelo cliente no checkout. O CEP é opcional:
 * o campo não é mais exibido para o cliente final.
 */
export interface AddressParts {
  street?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  cep?: string | null;
}

/** Remove acentos/pontuação para comparar nomes de rua e bairro. */
function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Dois nomes de rua iguais (tolerando "Avenida X" × "X"). */
function sameStreetName(found: unknown, wanted: string): boolean {
  const a = normalizeName(found);
  if (!a || !wanted) return false;
  if (a === wanted) return true;
  return a.includes(wanted) || wanted.includes(a);
}

/**
 * Geocodifica um endereço digitado **exigindo o número da casa**.
 *
 * É a única forma aceitável de obter a posição do cliente sem o Google Places:
 * a consulta é estruturada (`street=<número> <rua>`) e o resultado só é aceito
 * quando o Nominatim devolve `house_number` igual ao número informado, com a
 * mesma rua (e cidade, quando informada).
 *
 * Resultados de nível de rua (centroide do logradouro) são **descartados**:
 * eles são a causa das distâncias irreais (ex.: 1,4 km para um endereço a
 * 13,4 km), porque o OSM guarda a via em vários trechos espalhados pela cidade.
 * Quando não há número confirmado, retorna `null` e o checkout pede que o
 * cliente escolha uma sugestão no autocomplete.
 */
export async function geocodeAddressNumberExact(
  parts: AddressParts
): Promise<GeoPoint | null> {
  const street = clean(parts.street);
  const number = clean(parts.number);
  if (!street || !number) return null;

  const city = clean(parts.city);
  const state = clean(parts.state);
  const cep = parseCep(parts.cep ?? "");
  // Sem cidade e sem CEP não há contexto suficiente para a busca estruturada.
  if (!city && !cep) return null;

  const results = await searchNominatimResults({
    street: `${number} ${street}`,
    city: city ?? undefined,
    state: state ?? undefined,
    limit: 5,
  });

  const wantedNumber = number.replace(/\D/g, "");
  if (!wantedNumber) return null;
  const wantedStreet = normalizeName(street);
  const wantedCity = normalizeName(city);

  for (const row of results) {
    const foundNumber = (clean(row.address?.house_number) ?? "").replace(
      /\D/g,
      ""
    );
    // Sem número no resultado = centroide da rua → nunca serve para o frete.
    if (!foundNumber || foundNumber !== wantedNumber) continue;

    if (
      !sameStreetName(row.address?.road ?? row.address?.pedestrian, wantedStreet)
    ) {
      continue;
    }

    if (wantedCity) {
      const foundCity = normalizeName(
        row.address?.city ??
          row.address?.town ??
          row.address?.village ??
          row.address?.municipality
      );
      if (foundCity && foundCity !== wantedCity) continue;
    }

    const latitude = toFiniteNumber(row.lat);
    const longitude = toFiniteNumber(row.lon);
    if (latitude == null || longitude == null) continue;
    if (latitude === 0 && longitude === 0) continue;

    return { latitude, longitude };
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

/**
 * Endereço por extenso resolvido pela API de geocodificação.
 *
 * Usado como **origem do frete** na tela de configurações da loja: o lojista
 * digita rua + número e a coordenada exata substitui o centroide do CEP.
 */
export interface GeocodedAddress {
  latitude: number;
  longitude: number;
  /** Endereço formatado (o mais completo possível) para exibição. */
  label: string;
  street: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  cep: string | null;
}

/** Monta o texto do endereço devolvido pelo Nominatim (rua, bairro, cidade). */
function formatNominatimAddress(place: NominatimSearchResult): string | null {
  const parts = place.address ?? {};
  const street = clean(parts.road ?? parts.pedestrian);
  const number = clean(parts.house_number);
  const neighborhood = clean(
    parts.neighbourhood ?? parts.suburb ?? parts.city_district
  );
  const city = clean(
    parts.city ?? parts.town ?? parts.village ?? parts.municipality
  );
  const state = clean(parts.state);
  const postcode = clean(parts.postcode);

  const label = buildAddressQuery([
    street && number ? `${street}, ${number}` : street,
    neighborhood,
    [city, state].filter((part) => part !== "").join("/"),
    postcode ? `CEP ${postcode}` : null,
  ]);

  return label || clean(place.display_name);
}

/**
 * Geocodifica um endereço digitado por extenso (rua, número, bairro, cidade).
 *
 * Diferente de `lookupCep`, usa o texto livre do lojista — é o que permite
 * fixar a origem do frete na coordenada exata do imóvel em vez do centroide do
 * CEP (que em avenidas longas fica a quilômetros do portão da loja).
 *
 * Retorna `null` quando o texto é curto demais ou não é encontrado, deixando a
 * decisão de mensagem para quem chama. Falhas externas nunca lançam exceção.
 */
export async function geocodeStoreAddress(
  rawAddress: unknown
): Promise<GeocodedAddress | null> {
  const typed = clean(typeof rawAddress === "string" ? rawAddress : null);
  if (!typed || typed.length < STORE_ADDRESS_MIN_LENGTH) return null;

  // "Brasil" ajuda o Nominatim a não resolver homônimos de outros países.
  const query = /brasil/i.test(typed) ? typed : `${typed}, Brasil`;
  const place = await searchNominatim(query);
  if (!place) return null;

  const latitude = toFiniteNumber(place.lat);
  const longitude = toFiniteNumber(place.lon);
  if (latitude == null || longitude == null) return null;
  if (latitude === 0 && longitude === 0) return null;

  const parts = place.address ?? {};
  return {
    latitude,
    longitude,
    label: formatNominatimAddress(place) ?? typed,
    street: clean(parts.road ?? parts.pedestrian),
    neighborhood: clean(
      parts.neighbourhood ?? parts.suburb ?? parts.city_district
    ),
    city: clean(
      parts.city ?? parts.town ?? parts.village ?? parts.municipality
    ),
    state: clean(parts.state),
    cep: parseCep(parts.postcode),
  };
}

