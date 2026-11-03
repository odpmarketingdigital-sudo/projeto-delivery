import { parseCep, parseGeoPoint, toFiniteNumber } from "@/lib/delivery";

/**
 * Google Maps JavaScript API (biblioteca **Places**) no navegador.
 *
 * Usado pelo `<AddressAutocomplete>` do checkout: ao digitar, o Google sugere
 * endereços e, ao selecionar, entregamos rua/número/bairro/cidade/CEP e as
 * coordenadas para o formulário — as coordenadas alimentam o cálculo de rota
 * no servidor (`lib/googleRoutes.ts`).
 *
 * Regras de segurança:
 *  - só a chave **pública** (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) chega ao
 *    navegador; ela deve ter restrição por HTTP referrer e apenas as APIs
 *    Places/Maps JS habilitadas;
 *  - sem chave, nada é carregado e o formulário continua 100% funcional
 *    (o servidor calcula a distância pelo CEP).
 *
 * Sem dependência externa: usamos a API nativa com tipos mínimos declarados
 * abaixo (evita `@types/google.maps` só para o autocomplete).
 */

export const GOOGLE_MAPS_SCRIPT_ID = "ipepper-google-maps-script";

/** Tempo máximo aguardando a biblioteca Places ficar disponível. */
const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 100;

export interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

export interface GooglePlaceResult {
  place_id?: string;
  formatted_address?: string;
  name?: string;
  address_components?: GoogleAddressComponent[];
  geometry?: { location?: unknown };
}

export interface GoogleAutocompleteOptions {
  componentRestrictions?: { country: string | string[] };
  fields?: string[];
  types?: string[];
  strictBounds?: boolean;
}

export interface GoogleAutocomplete {
  addListener(event: string, handler: () => void): { remove(): void };
  getPlace(): GooglePlaceResult;
}

/** Construtor de `google.maps.places.Autocomplete`. */
export type GoogleAutocompleteCtor = new (
  input: HTMLInputElement,
  options?: GoogleAutocompleteOptions
) => GoogleAutocomplete;

interface GoogleMapsNamespace {
  maps?: {
    places?: {
      Autocomplete?: GoogleAutocompleteCtor;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleMapsNamespace;
  }
}

/** Endereço normalizado devolvido pelo componente de autocomplete. */
export interface GooglePlaceAddress {
  street: string | null;
  number: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  cep: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  formattedAddress: string | null;
}

/** Chave pública do Maps JS (inlinada no build pelo Next). */
export function getGoogleMapsBrowserKey(): string | null {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const trimmed = typeof key === "string" ? key.trim() : "";
  return trimmed ? trimmed : null;
}

/** O autocomplete só aparece quando a chave pública está configurada. */
export function isGooglePlacesEnabled(): boolean {
  return getGoogleMapsBrowserKey() != null;
}

function getAutocompleteCtor(): GoogleAutocompleteCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = window.google?.maps?.places?.Autocomplete;
  return typeof ctor === "function" ? ctor : null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A Maps JS API é carregada com `loading=async`: o `onload` do `<script>` pode
 * disparar antes de `google.maps.places` existir. Por isso aguardamos o
 * construtor aparecer (com timeout) em vez de confiar apenas no evento.
 */
async function waitForAutocompleteCtor(): Promise<GoogleAutocompleteCtor | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ctor = getAutocompleteCtor();
    if (ctor) return ctor;
    await sleep(READY_POLL_MS);
  }
  return null;
}

let loaderPromise: Promise<GoogleAutocompleteCtor | null> | null = null;

/**
 * Carrega (uma única vez por página) a biblioteca Places e devolve o
 * construtor de `Autocomplete`. Retorna `null` quando não há chave, quando o
 * script falha ou quando o navegador está offline — nunca lança.
 */
export function loadGooglePlacesAutocomplete(): Promise<GoogleAutocompleteCtor | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const key = getGoogleMapsBrowserKey();
  if (!key) return Promise.resolve(null);

  const alreadyReady = getAutocompleteCtor();
  if (alreadyReady) return Promise.resolve(alreadyReady);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<GoogleAutocompleteCtor | null>((resolve) => {
    const existing = document.getElementById(
      GOOGLE_MAPS_SCRIPT_ID
    ) as HTMLScriptElement | null;

    if (existing) {
      // Script já injetado (ex.: segunda montagem do componente).
      void waitForAutocompleteCtor().then(resolve);
      return;
    }

    const script = document.createElement("script");
    script.id = GOOGLE_MAPS_SCRIPT_ID;
    script.src =
      "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(key)}` +
      "&libraries=places&language=pt-BR&region=BR&loading=async";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      void waitForAutocompleteCtor().then(resolve);
    };
    script.onerror = () => resolve(null);

    document.head.appendChild(script);
  });

  return loaderPromise;
}

/** Primeiro `long_name` não vazio entre os tipos informados. */
function componentValue(
  components: GoogleAddressComponent[],
  types: string[]
): string | null {
  for (const type of types) {
    const match = components.find((component) =>
      Array.isArray(component.types) ? component.types.includes(type) : false
    );
    const value = match?.long_name?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Lê uma coordenada de `geometry.location`.
 *
 * A API clássica devolve funções (`location.lat()`); a versão nova pode
 * devolver `{ lat, lng }`. Aceitamos as duas formas.
 */
function readCoordinate(location: unknown, axis: "lat" | "lng"): number | null {
  if (!location || typeof location !== "object") return null;
  const record = location as Record<string, unknown>;
  const raw = record[axis];
  if (typeof raw === "function") {
    const value = (raw as () => unknown).call(location);
    return toFiniteNumber(value);
  }
  return toFiniteNumber(raw);
}

/**
 * Converte o resultado do Places nos campos do formulário de entrega.
 * Retorna `null` quando o lugar não tem endereço utilizável.
 */
export function extractPlaceAddress(
  place: GooglePlaceResult | null | undefined
): GooglePlaceAddress | null {
  if (!place || typeof place !== "object") return null;

  const components = Array.isArray(place.address_components)
    ? place.address_components
    : [];

  const street = componentValue(components, [
    "route",
    "street_address",
    "premise",
  ]);
  const number = componentValue(components, ["street_number"]);
  const neighborhood = componentValue(components, [
    "sublocality_level_1",
    "sublocality",
    "neighborhood",
    "administrative_area_level_4",
    "administrative_area_level_3",
  ]);
  const city = componentValue(components, [
    "administrative_area_level_2",
    "locality",
    "postal_town",
  ]);
  const state = componentValue(components, ["administrative_area_level_1"]);
  const cep = parseCep(
    componentValue(components, ["postal_code", "postal_code_prefix"])
  );

  const point = parseGeoPoint(
    readCoordinate(place.geometry?.location, "lat"),
    readCoordinate(place.geometry?.location, "lng")
  );

  const formattedAddress = place.formatted_address?.trim() || null;
  if (!street && !formattedAddress && !point) return null;

  return {
    street: street ?? formattedAddress,
    number,
    neighborhood,
    city,
    state,
    cep,
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    placeId: place.place_id?.trim() || null,
    formattedAddress,
  };
}
