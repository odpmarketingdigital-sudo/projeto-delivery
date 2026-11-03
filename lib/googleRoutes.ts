import { roundDistanceKm, type GeoPoint } from "@/lib/delivery";

/**
 * Distância e tempo de percurso reais via **Google Routes API**
 * (`directions/v2:computeRoutes`).
 *
 * Usado pela cotação de entrega (`lib/deliveryQuote.ts`), chamada por
 * `POST /api/delivery-quote` (pré-visualização no checkout) e por
 * `POST /api/orders` (validação final antes de gravar o pedido).
 *
 * Princípios:
 *  - a chave é **somente do servidor** (`GOOGLE_MAPS_API_KEY`); quando o
 *    projeto usa uma única chave habilitada para navegador e servidor, cai em
 *    `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` como conveniência;
 *  - qualquer falha (sem chave, API desabilitada, timeout, cota) devolve
 *    `null` e a cotação segue com o cálculo em linha reta (Haversine);
 *  - resultados positivos ficam em cache por instância para não cobrar duas
 *    vezes a mesma origem/destino durante a navegação do checkout.
 *
 * Docs: https://developers.google.com/maps/documentation/routes/compute_route_direction
 */

const ROUTES_ENDPOINT =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

/** Timeout curto: a taxa de entrega nunca deve travar o checkout. */
const REQUEST_TIMEOUT_MS = 4000;

/** Cache de rotas (trânsito muda com o tempo — TTL curto). */
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

/** Campos pedidos ao Google (FieldMask reduz latência e custo). */
const FIELD_MASK = "routes.distanceMeters,routes.duration";

export interface RouteEstimate {
  /** Distância da rota em km (2 casas decimais). */
  distanceKm: number;
  /** Tempo estimado de percurso em minutos (arredondado). */
  durationMinutes: number | null;
}

const routeCache = new Map<
  string,
  { value: RouteEstimate; expiresAt: number }
>();

let loggedMissingKey = false;
let loggedFailure = false;

/**
 * Chave de servidor do Google Maps.
 *
 * `GOOGLE_MAPS_API_KEY` é a recomendada (sem restrição de HTTP referrer).
 * `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` é aceita como fallback para projetos que
 * usam uma única chave — nesse caso ela precisa permitir chamadas de servidor
 * (restrição por IP ou sem restrição de referrer).
 */
export function getGoogleMapsServerKey(): string | null {
  const serverKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (serverKey) return serverKey;
  const publicKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  return publicKey ? publicKey : null;
}

/** Indica se o cálculo por rota está configurado (chave presente). */
export function isGoogleRoutesConfigured(): boolean {
  return getGoogleMapsServerKey() != null;
}

function cacheKey(origin: GeoPoint, destination: GeoPoint): string {
  // ~1 m de precisão: evita cache miss por ruído de coordenadas do navegador.
  const round = (value: number) => value.toFixed(5);
  return [
    round(origin.latitude),
    round(origin.longitude),
    round(destination.latitude),
    round(destination.longitude),
  ].join("|");
}

function readCache(key: string): RouteEstimate | null {
  const entry = routeCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    routeCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: RouteEstimate): void {
  if (routeCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = routeCache.keys().next();
    if (!oldest.done) routeCache.delete(oldest.value);
  }
  routeCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Converte `"1234s"` (duração do Google) em segundos. */
function parseDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

interface ComputeRoutesResponse {
  routes?: Array<{ distanceMeters?: unknown; duration?: unknown }>;
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Calcula distância/tempo de carro entre dois pontos.
 *
 * Retorna `null` quando não há chave configurada, a API falha ou não existe
 * rota — o chamador decide o fallback (Haversine).
 */
export async function computeRouteEstimate(
  origin: GeoPoint,
  destination: GeoPoint
): Promise<RouteEstimate | null> {
  const key = getGoogleMapsServerKey();
  if (!key) {
    if (!loggedMissingKey) {
      loggedMissingKey = true;
      console.warn(
        "[googleRoutes] GOOGLE_MAPS_API_KEY ausente — distância de entrega será calculada em linha reta."
      );
    }
    return null;
  }

  const routeKey = cacheKey(origin, destination);
  const cached = readCache(routeKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ROUTES_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        origin: {
          location: {
            latLng: {
              latitude: origin.latitude,
              longitude: origin.longitude,
            },
          },
        },
        destination: {
          location: {
            latLng: {
              latitude: destination.latitude,
              longitude: destination.longitude,
            },
          },
        },
        travelMode: "DRIVE",
        // Trânsito real: é o que o entregador enfrenta na rua.
        routingPreference: "TRAFFIC_AWARE",
        computeAlternativeRoutes: false,
        languageCode: "pt-BR",
        regionCode: "BR",
        units: "METRIC",
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      if (!loggedFailure) {
        loggedFailure = true;
        console.warn(
          `[googleRoutes] computeRoutes falhou (HTTP ${response.status}): ${detail.slice(0, 300)}`
        );
      }
      return null;
    }

    const data = (await response.json()) as ComputeRoutesResponse;
    const route = data.routes?.[0];
    const distanceMeters = Number(route?.distanceMeters);
    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
      return null;
    }

    const seconds = parseDurationSeconds(route?.duration);
    const estimate: RouteEstimate = {
      distanceKm: roundDistanceKm(distanceMeters / 1000),
      durationMinutes:
        seconds != null ? Math.max(1, Math.round(seconds / 60)) : null,
    };

    writeCache(routeKey, estimate);
    return estimate;
  } catch (error) {
    if (!loggedFailure) {
      loggedFailure = true;
      console.warn(
        "[googleRoutes] computeRoutes indisponível:",
        error instanceof Error ? error.message : error
      );
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
