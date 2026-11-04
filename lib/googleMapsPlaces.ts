import { parseCep, parseGeoPoint, toFiniteNumber } from "@/lib/delivery";

/**
 * Google Maps JavaScript API — **Places API (New)** no navegador.
 *
 * Usado pelo `<AddressAutocomplete>` do checkout: ao digitar, o Web Component
 * `<gmp-place-autocomplete>` (`google.maps.places.PlaceAutocompleteElement`)
 * sugere endereços e, ao selecionar, entregamos rua/número/bairro/cidade/CEP e
 * as coordenadas para o formulário — as coordenadas alimentam o cálculo de rota
 * no servidor (`lib/googleRoutes.ts`).
 *
 * Por que o Web Component e não `google.maps.places.Autocomplete`?
 *  - a classe legada depende da **Places API** antiga: contas do Google Cloud
 *    criadas a partir de março/2025 não conseguem ativá-la e o console acusa
 *    `LegacyApiNotActivatedMapError`;
 *  - o `PlaceAutocompleteElement` usa a **Places API (New) / Places UI Kit**,
 *    que é o caminho suportado atualmente e já devolve `addressComponents` no
 *    formato novo (`longText`/`shortText`).
 *
 * Regras de segurança:
 *  - só a chave **pública** (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) chega ao
 *    navegador; ela deve ter restrição por HTTP referrer e apenas as APIs
 *    Maps JavaScript / Places API (New) / Places UI Kit habilitadas;
 *  - sem chave, nada é carregado e o formulário continua 100% funcional
 *    (o servidor calcula a distância pelo CEP).
 *
 * Sem dependência externa: usamos a API nativa com os tipos mínimos declarados
 * abaixo (evita `@types/google.maps` só para o autocomplete).
 */

export const GOOGLE_MAPS_SCRIPT_ID = "ipepper-google-maps-script";

/**
 * Versão da Maps JS API carregada pelo script.
 *
 * `weekly` é exigida pelo `PlaceAutocompleteElement` (Places UI Kit): o widget
 * é publicado nesse canal e não aparece em versões fixas/`quarterly`.
 */
export const GOOGLE_MAPS_API_VERSION = "weekly";

/** Biblioteca que expõe `google.maps.places.PlaceAutocompleteElement`. */
const GOOGLE_MAPS_LIBRARY = "places";

/** Tempo máximo aguardando a biblioteca Places ficar disponível. */
const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 100;

/**
 * Campos pedidos ao Place Details (New) em `place.fetchFields()`.
 * Pedir apenas o necessário reduz o custo por seleção.
 */
const PLACE_DETAIL_FIELDS = [
  "displayName",
  "formattedAddress",
  "addressComponents",
  "location",
];

export interface GoogleAddressComponent {
  /** Nome completo ("Rua das Flores") — Places API (New). */
  longText?: string | null;
  /** Abreviação ("SP") — Places API (New). */
  shortText?: string | null;
  types?: string[] | null;
  /** Nomes usados pelo Places legado — aceitos para tolerância. */
  long_name?: string | null;
  short_name?: string | null;
}

/** `LatLng` do Places (New): `lat`/`lng` numéricos. */
export interface GoogleLatLngLike {
  lat?: unknown;
  lng?: unknown;
}

/** Local (`google.maps.places.Place`) devolvido por `placePrediction.toPlace()`. */
export interface GooglePlace {
  /** `place_id` (`ChIJ...`) — usado como referência do endereço. */
  id?: string;
  displayName?: string | null;
  formattedAddress?: string | null;
  addressComponents?: GoogleAddressComponent[] | null;
  location?: GoogleLatLngLike | null;
  /** Carrega os detalhes do lugar (Places API New). */
  fetchFields?: (request: { fields: string[] }) => Promise<unknown>;
}

/** Sugestão do widget (`event.placePrediction`). */
export interface GooglePlacePrediction {
  placeId?: string;
  toPlace: () => GooglePlace;
}

/**
 * Detalhe do evento de seleção do Web Component.
 *
 * O evento atual é `gmp-select` e traz `placePrediction`; versões anteriores do
 * widget usavam `gmp-placeselect` com a propriedade `prediction` (e algumas
 * builds entregavam `place` já resolvido). Aceitamos as três formas.
 */
export interface GooglePlaceSelectEvent {
  place?: GooglePlace | null;
  placePrediction?: GooglePlacePrediction | null;
  prediction?: GooglePlacePrediction | null;
}

export interface GooglePlaceAutocompleteElementOptions {
  /** Restringe as sugestões aos países informados (ISO 3166-1 alpha-2). */
  includedRegionCodes?: string[];
  /** Tipos primários aceitos (ex.: `street_address`, `route`). */
  includedPrimaryTypes?: string[];
  placeholder?: string;
  name?: string;
}

/**
 * `google.maps.places.PlaceAutocompleteElement` — Web Component
 * `<gmp-place-autocomplete>`, renderizado em shadow DOM.
 */
export interface GooglePlaceAutocompleteElement extends HTMLElement {
  value: string;
  includedRegionCodes?: string[];
  includedPrimaryTypes?: string[];
  placeholder?: string;
  name?: string;
}

/** Construtor de `google.maps.places.PlaceAutocompleteElement`. */
export type GooglePlaceAutocompleteElementCtor = new (
  options?: GooglePlaceAutocompleteElementOptions
) => GooglePlaceAutocompleteElement;

interface GoogleMapsNamespaceMaps {
  /** Disponível no bootstrap/`loading=async` da Maps JS API. */
  importLibrary?: (library: string) => Promise<unknown>;
  places?: {
    PlaceAutocompleteElement?: GooglePlaceAutocompleteElementCtor;
  };
}

interface GoogleMapsNamespace {
  maps?: GoogleMapsNamespaceMaps;
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

/**
 * URL do script da Maps JS API.
 *
 * `libraries=places` + `v=weekly` são o que expõe a Places Library nova
 * (Places UI Kit). `loading=async` evita bloquear a renderização do checkout.
 */
export function buildGoogleMapsScriptUrl(key: string): string {
  const params = new URLSearchParams({
    key,
    v: GOOGLE_MAPS_API_VERSION,
    libraries: GOOGLE_MAPS_LIBRARY,
    language: "pt-BR",
    region: "BR",
    loading: "async",
  });
  return `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
}

function getPlaceAutocompleteElementCtor(): GooglePlaceAutocompleteElementCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = window.google?.maps?.places?.PlaceAutocompleteElement;
  return typeof ctor === "function" ? ctor : null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A Maps JS API é carregada com `loading=async`: o `onload` do `<script>` pode
 * disparar antes de `google.maps.places` existir. Por isso aguardamos o
 * construtor aparecer (com timeout) em vez de confiar apenas no evento.
 *
 * Quando `google.maps.importLibrary` está disponível (bootstrap oficial),
 * pedimos a biblioteca explicitamente — é o caminho documentado e resolve a
 * corrida mais rápido.
 */
async function waitForPlaceAutocompleteElementCtor(): Promise<GooglePlaceAutocompleteElementCtor | null> {
  const maps = typeof window === "undefined" ? undefined : window.google?.maps;
  if (typeof maps?.importLibrary === "function") {
    void maps.importLibrary(GOOGLE_MAPS_LIBRARY).catch(() => {
      // Sem a biblioteca não há widget: o componente cai no input comum.
    });
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ctor = getPlaceAutocompleteElementCtor();
    if (ctor) return ctor;
    await sleep(READY_POLL_MS);
  }
  return null;
}

let loaderPromise: Promise<GooglePlaceAutocompleteElementCtor | null> | null =
  null;

/**
 * Carrega (uma única vez por página) a Maps JS API com a biblioteca Places e
 * devolve o construtor de `PlaceAutocompleteElement`. Retorna `null` quando não
 * há chave, quando o script falha ou quando o navegador está offline — nunca
 * lança.
 */
export function loadGooglePlaceAutocompleteElement(): Promise<GooglePlaceAutocompleteElementCtor | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const key = getGoogleMapsBrowserKey();
  if (!key) return Promise.resolve(null);

  const alreadyReady = getPlaceAutocompleteElementCtor();
  if (alreadyReady) return Promise.resolve(alreadyReady);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<GooglePlaceAutocompleteElementCtor | null>(
    (resolve) => {
      const existing = document.getElementById(
        GOOGLE_MAPS_SCRIPT_ID
      ) as HTMLScriptElement | null;

      if (existing) {
        // Script já injetado (ex.: segunda montagem do componente).
        void waitForPlaceAutocompleteElementCtor().then(resolve);
        return;
      }

      const script = document.createElement("script");
      script.id = GOOGLE_MAPS_SCRIPT_ID;
      script.src = buildGoogleMapsScriptUrl(key);
      script.async = true;
      script.defer = true;
      script.onload = () => {
        void waitForPlaceAutocompleteElementCtor().then(resolve);
      };
      script.onerror = () => resolve(null);

      document.head.appendChild(script);
    }
  );

  return loaderPromise;
}

/** Texto não vazio (string aparada) ou `null`. */
function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Primeiro `longText` não vazio entre os tipos informados.
 *
 * A Places API (New) devolve `longText`/`shortText`; o formato legado
 * (`long_name`/`short_name`) continua aceito para não quebrar se a API
 * responder no formato antigo.
 */
function componentValue(
  components: GoogleAddressComponent[],
  types: string[]
): string | null {
  for (const type of types) {
    const match = components.find((component) =>
      Array.isArray(component.types) ? component.types.includes(type) : false
    );
    const value = readText(match?.longText ?? match?.long_name);
    if (value) return value;
  }
  return null;
}

/**
 * Lê uma coordenada de `place.location`.
 *
 * A Places API (New) devolve `location` como `LatLng` (`lat()`/`lng()`); o
 * Places legado devolvia o mesmo formato em `geometry.location` e algumas
 * respostas trazem `{ lat, lng }` numérico. Aceitamos as duas formas.
 */
function readCoordinate(
  location: GoogleLatLngLike | null | undefined,
  axis: "lat" | "lng"
): number | null {
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
 * Converte o `Place` do Places (New) nos campos do formulário de entrega.
 * Retorna `null` quando o lugar não tem endereço utilizável.
 */
export function extractPlaceAddress(
  place: GooglePlace | null | undefined
): GooglePlaceAddress | null {
  if (!place || typeof place !== "object") return null;

  const components = Array.isArray(place.addressComponents)
    ? place.addressComponents
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
    readCoordinate(place.location, "lat"),
    readCoordinate(place.location, "lng")
  );

  const formattedAddress = readText(place.formattedAddress);
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
    placeId: readText(place.id),
    formattedAddress,
  };
}

/**
 * Busca os detalhes do lugar (`fetchFields`) e normaliza para o formulário.
 *
 * `fetchFields` pode falhar (campo inválido, cota, offline): nesse caso seguimos
 * com o que a sugestão já trouxe, para nunca travar o checkout.
 */
export async function fetchPlaceAddress(
  place: GooglePlace | null | undefined
): Promise<GooglePlaceAddress | null> {
  if (!place || typeof place !== "object") return null;

  if (typeof place.fetchFields === "function") {
    try {
      await place.fetchFields({ fields: [...PLACE_DETAIL_FIELDS] });
    } catch (error) {
      console.warn("[googleMapsPlaces] fetchFields falhou", error);
    }
  }

  return extractPlaceAddress(place);
}

/**
 * Normaliza o evento de seleção.
 *
 * O Places UI Kit entrega as propriedades direto no evento (`placePrediction`),
 * mas algumas versões/builds usam `CustomEvent` com o dado em `detail` —
 * aceitamos as duas formas.
 */
function asPlaceSelectEvent(
  event: GooglePlaceSelectEvent | null | undefined
): GooglePlaceSelectEvent | null {
  if (!event || typeof event !== "object") return null;
  const detail = (event as { detail?: unknown }).detail;
  if (detail && typeof detail === "object") {
    return detail as GooglePlaceSelectEvent;
  }
  return event;
}

/**
 * Extrai o `Place` do detalhe do evento `gmp-select`.
 *
 * Aceita `placePrediction`/`prediction` (chamando `toPlace()`) e também um
 * `place` já resolvido, conforme a versão do widget.
 */
export function getSelectedPlace(
  event: GooglePlaceSelectEvent | null | undefined
): GooglePlace | null {
  const normalized = asPlaceSelectEvent(event);
  if (!normalized) return null;
  if (normalized.place && typeof normalized.place === "object") {
    return normalized.place;
  }

  const prediction =
    normalized.placePrediction ?? normalized.prediction ?? null;
  if (!prediction || typeof prediction.toPlace !== "function") return null;

  try {
    const place = prediction.toPlace();
    return place && typeof place === "object" ? place : null;
  } catch (error) {
    console.warn("[googleMapsPlaces] toPlace falhou", error);
    return null;
  }
}

/**
 * Fluxo completo de uma seleção no autocomplete: `toPlace()` →
 * `fetchFields()` → endereço normalizado. Retorna `null` quando o evento não
 * traz um lugar utilizável.
 *
 * O `placeId` cai para o `placeId` da sugestão quando o `Place` não o expõe:
 * o checkout usa esse valor como referência do endereço no pedido.
 */
export async function readSelectedPlaceAddress(
  event: GooglePlaceSelectEvent | null | undefined
): Promise<GooglePlaceAddress | null> {
  const normalized = asPlaceSelectEvent(event);
  const prediction =
    normalized?.placePrediction ?? normalized?.prediction ?? null;
  const address = await fetchPlaceAddress(getSelectedPlace(event));
  if (!address) return null;

  const predictionPlaceId = readText(prediction?.placeId);
  if (!address.placeId && predictionPlaceId) {
    return { ...address, placeId: predictionPlaceId };
  }
  return address;
}




