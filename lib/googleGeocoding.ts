import { getGoogleMapsServerKey } from "@/lib/googleRoutes";

/**
 * Google **Geocoding API** (servidor) — geocodificação por endereço com
 * número exato.
 *
 * Usada pela cotação de entrega (`lib/deliveryQuote.ts`) como fallback quando o
 * cliente não escolheu uma sugestão no autocomplete do checkout: converte
 * `rua + número + cidade` nas coordenadas da **porta**, e não no centroide da
 * rua (que é o que causa distâncias irreais, ex.: 1,4 km para um endereço a
 * 13,4 km de distância).
 *
 * Regras de aceitação (todas obrigatórias):
 *  - a resposta precisa trazer o componente `street_number`;
 *  - `geometry.location_type` precisa ser `ROOFTOP` ou `RANGE_INTERPOLATED`
 *    (`GEOMETRIC_CENTER`/`APPROXIMATE` são centroides → descartados);
 *  - o número e a rua devolvidos precisam casar com o que o cliente digitou.
 *
 * A API é **opcional**: se `GOOGLE_MAPS_API_KEY` não existir ou a Geocoding API
 * não estiver habilitada no projeto (HTTP 403/`REQUEST_DENIED`), a função
 * devolve `null` e a cotação segue para o Nominatim estrito. A negativa fica em
 * cache curto para não gastar latência em toda cotação.
 *
 * Docs: https://developers.google.com/maps/documentation/geocoding/requests-geocoding
 */

const GEOCODING_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/** Timeout curto: o checkout nunca deve ficar preso em um geocode. */
const REQUEST_TIMEOUT_MS = 4000;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

/** Quanto tempo não insistimos quando a API está desabilitada para a chave. */
const DISABLED_TTL_MS = 10 * 60 * 1000;

/** Tipos de localização aceitos (nível de número, nunca centroide). */
const PRECISE_LOCATION_TYPES = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);

/** Partes do endereço do cliente usadas no geocode exato. */
export interface GeocodingAddressParts {
  street: string | null;
  number: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  cep?: string | null;
}

/** Ponto geográfico (mesmo formato de `GeoPoint` em `lib/delivery`). */
export interface GeocodingPoint {
  latitude: number;
  longitude: number;
}

interface GeocodingAddressComponent {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

interface GeocodingResult {
  address_components?: GeocodingAddressComponent[];
  formatted_address?: string;
  partial_match?: boolean;
  geometry?: {
    location?: { lat?: number; lng?: number };
    location_type?: string;
  };
}

interface GeocodingResponse {
  status?: string;
  error_message?: string;
  results?: GeocodingResult[];
}

const cache = new Map<
  string,
  { value: GeocodingPoint | null; expiresAt: number }
>();

/** Quando a chave não pode usar a Geocoding API, não insistimos por um tempo. */
let disabledUntil = 0;
let loggedFailure = false;

function readCache(key: string): GeocodingPoint | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache(key: string, value: GeocodingPoint | null): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function readComponent(
  components: GeocodingAddressComponent[],
  type: string
): string | null {
  const match = components.find((component) =>
    Array.isArray(component.types) ? component.types.includes(type) : false
  );
  const value = (match?.long_name ?? match?.short_name ?? "").trim();
  return value ? value : null;
}

/** Indica se o geocode exato está disponível (chave configurada e API aceita). */
export function isGoogleGeocodingAvailable(): boolean {
  return getGoogleMapsServerKey() != null && Date.now() >= disabledUntil;
}


/**
 * Geocodifica o endereço do cliente exigindo o **número da casa**.
 *
 * Retorna `null` sempre que a precisão não puder ser comprovada — o chamador
 * decide como avisar o cliente. Nunca lança.
 */
export async function geocodeAddressExactWithGoogle(
  parts: GeocodingAddressParts
): Promise<GeocodingPoint | null> {
  const street = (parts.street ?? "").trim();
  const number = (parts.number ?? "").trim();
  const city = (parts.city ?? "").trim();
  const state = (parts.state ?? "").trim();
  const cep = (parts.cep ?? "").replace(/\D/g, "");
  if (!street || !number || (!city && cep.length !== 8)) return null;

  const key = getGoogleMapsServerKey();
  if (!key || Date.now() < disabledUntil) return null;

  const address = [
    `${street}, ${number}`,
    (parts.neighborhood ?? "").trim(),
    [city, state].filter(Boolean).join(" - "),
    cep,
    "Brasil",
  ]
    .filter((part) => Boolean(part))
    .join(", ");

  const cacheKey = address.toLowerCase();
  const cached = readCache(cacheKey);
  if (cached !== undefined) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(GEOCODING_ENDPOINT);
    url.searchParams.set("address", address);
    url.searchParams.set("key", key);
    url.searchParams.set("language", "pt-BR");
    url.searchParams.set("region", "br");
    // Componente obrigatório: o retorno precisa estar no Brasil (evita
    // homônimos de rua em outros países quando o texto é curto).
    url.searchParams.set("components", "country:BR");

    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      // 403 = Geocoding API não habilitada/restrita para esta chave.
      if (response.status === 403) disabledUntil = Date.now() + DISABLED_TTL_MS;
      writeCache(cacheKey, null);
      return null;
    }

    const data = (await response.json()) as GeocodingResponse;
    if (data.status === "REQUEST_DENIED" || data.status === "OVER_QUERY_LIMIT") {
      disabledUntil = Date.now() + DISABLED_TTL_MS;
      if (!loggedFailure) {
        loggedFailure = true;
        console.warn(
          "[googleGeocoding] indisponível:",
          data.status,
          data.error_message ?? ""
        );
      }
      writeCache(cacheKey, null);
      return null;
    }

    if (data.status !== "OK") {
      writeCache(cacheKey, null);
      return null;
    }

    const wantedNumber = number.replace(/\D/g, "");
    const wantedStreet = normalizeName(street);

    for (const result of data.results ?? []) {
      const components = Array.isArray(result.address_components)
        ? result.address_components
        : [];

      const locationType = result.geometry?.location_type ?? "";
      if (!PRECISE_LOCATION_TYPES.has(locationType)) continue;

      const foundNumber = (readComponent(components, "street_number") ?? "")
        .replace(/\D/g, "");
      if (!wantedNumber || foundNumber !== wantedNumber) continue;

      const foundStreet = normalizeName(readComponent(components, "route"));
      if (
        !foundStreet ||
        !(
          foundStreet === wantedStreet ||
          foundStreet.includes(wantedStreet) ||
          wantedStreet.includes(foundStreet)
        )
      ) {
        continue;
      }

      const latitude = result.geometry?.location?.lat;
      const longitude = result.geometry?.location?.lng;
      if (
        typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        (latitude === 0 && longitude === 0)
      ) {
        continue;
      }

      const point: GeocodingPoint = { latitude, longitude };
      writeCache(cacheKey, point);
      return point;
    }

    writeCache(cacheKey, null);
    return null;
  } catch (error) {
    if (!loggedFailure) {
      loggedFailure = true;
      console.warn(
        "[googleGeocoding] falhou:",
        error instanceof Error ? error.message : error
      );
    }
    writeCache(cacheKey, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
