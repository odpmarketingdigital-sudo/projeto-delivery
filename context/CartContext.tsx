"use client";

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CartItem, HalfHalfFlavor, Product, ProductOption } from "@/lib/types";
import type { OrderDeliveryType } from "@/lib/orderStatus";
import { parseCep } from "@/lib/delivery";
import {
  normalizeHalfHalfFlavors,
  resolveHalfHalfBasePrice,
  sameHalfHalfFlavors,
} from "@/lib/halfHalf";
import { products } from "@/lib/mockData";

const STORAGE_KEY = "@delivery:cart";

/**
 * Endereço usado pelo cliente no cálculo do frete (sacola e checkout). Fica no
 * contexto (e no localStorage) para chegar **pré-preenchido** ao checkout — o
 * cliente só revisa/ajusta o que quiser.
 *
 * O CEP continua sendo guardado à parte (`deliveryCep`, somente dígitos) por
 * compatibilidade com o link do modo catálogo. Ele não é mais digitado pelo
 * cliente: vem da busca automática de endereço (Google Places) ou do perfil.
 */
const DELIVERY_CEP_STORAGE_KEY = "@delivery:delivery-cep";
const DELIVERY_ADDRESS_STORAGE_KEY = "@delivery:delivery-address";
/**
 * Modalidade de atendimento escolhida pelo cliente (sacola → checkout).
 * Persistida para o cliente não precisar escolher de novo no próximo pedido.
 */
const ORDER_TYPE_STORAGE_KEY = "@delivery:order-type";

const EMPTY_ITEMS: CartItem[] = [];

/** Endereço de entrega salvo na sacola e reaproveitado no checkout. */
export interface CartDeliveryAddress {
  street: string;
  number: string;
  neighborhood: string;
  city?: string;
  complement?: string;
  /** CEP (somente dígitos) devolvido pela busca automática de endereço. */
  cep?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  /**
   * Endereço formatado devolvido pelo Google Places na seleção.
   * Usado apenas como feedback visual no checkout (não entra no pedido).
   */
  formattedAddress?: string;
}

/** Valor vazio estável (mesma referência em todos os renders/SSR). */
const EMPTY_DELIVERY_ADDRESS: CartDeliveryAddress | null = null;

/**
 * Store de um valor único no localStorage com `useSyncExternalStore`.
 *
 * O listener de `storage` é registrado UMA vez por store (e não um por
 * componente), evitando re-renders multiplicados a cada evento entre abas.
 */
function createStoredValue<T>({
  key,
  empty,
  parse,
  serialize,
}: {
  key: string;
  empty: T;
  parse: (raw: string | null) => T;
  serialize: (value: T) => string | null;
}) {
  const listeners = new Set<() => void>();
  let snapshot: T = empty;
  let loaded = false;
  let subscribers = 0;

  const load = (): T => {
    if (typeof window === "undefined") return empty;
    if (loaded) return snapshot;
    loaded = true;
    try {
      snapshot = parse(window.localStorage.getItem(key));
    } catch {
      // Storage indisponível (modo privado, quota etc.): mantém vazio.
      snapshot = empty;
    }
    return snapshot;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== key) return;
    loaded = false;
    snapshot = empty;
    load();
    notify();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    subscribers += 1;
    if (subscribers === 1) {
      window.addEventListener("storage", handleStorage);
    }
    return () => {
      listeners.delete(listener);
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        window.removeEventListener("storage", handleStorage);
      }
    };
  };

  const getSnapshot = (): T =>
    typeof window === "undefined" ? empty : load();

  const getServerSnapshot = (): T => empty;

  const set = (value: T) => {
    loaded = true;
    snapshot = value;
    try {
      const serialized = serialize(value);
      if (serialized === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, serialized);
      }
    } catch {
      // Falha de storage não deve interromper a sacola.
    }
    notify();
  };

  return { subscribe, getSnapshot, getServerSnapshot, set };
}

/** CEP da sacola (somente dígitos; vazio limpa). */
const deliveryCepStore = createStoredValue<string>({
  key: DELIVERY_CEP_STORAGE_KEY,
  empty: "",
  parse: (raw) => parseCep(raw) ?? "",
  serialize: (value) => (value ? value : null),
});

/** Persiste o CEP já normalizado (aceita qualquer formato de entrada). */
function setDeliveryCepValue(value: string) {
  deliveryCepStore.set(parseCep(value) ?? "");
}

/**
 * Lê/normaliza o endereço salvo, descartando JSON corrompido ou campos
 * inválidos (mesma tolerância do perfil do cliente em `lib/storage.ts`).
 */
function parseDeliveryAddress(raw: string | null): CartDeliveryAddress | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<CartDeliveryAddress> | null;
    if (!parsed || typeof parsed !== "object") return null;

    const text = (value: unknown): string =>
      typeof value === "string" ? value.trim() : "";
    const street = text(parsed.street);
    const number = text(parsed.number);
    const neighborhood = text(parsed.neighborhood);
    if (!street && !number && !neighborhood) return null;

    const latitude =
      typeof parsed.latitude === "number" && Number.isFinite(parsed.latitude)
        ? parsed.latitude
        : undefined;
    const longitude =
      typeof parsed.longitude === "number" && Number.isFinite(parsed.longitude)
        ? parsed.longitude
        : undefined;
    const city = text(parsed.city);
    const complement = text(parsed.complement);
    const cep = parseCep(parsed.cep ?? "") ?? "";
    const placeId = text(parsed.placeId);
    const formattedAddress = text(parsed.formattedAddress);

    return {
      street,
      number,
      neighborhood,
      ...(city ? { city } : {}),
      ...(complement ? { complement } : {}),
      ...(cep ? { cep } : {}),
      ...(latitude != null && longitude != null ? { latitude, longitude } : {}),
      ...(placeId ? { placeId } : {}),
      ...(formattedAddress ? { formattedAddress } : {}),
    };
  } catch {
    return null;
  }
}

const deliveryAddressStore = createStoredValue<CartDeliveryAddress | null>({
  key: DELIVERY_ADDRESS_STORAGE_KEY,
  empty: EMPTY_DELIVERY_ADDRESS,
  parse: parseDeliveryAddress,
  serialize: (value) => (value ? JSON.stringify(value) : null),
});

/**
 * Modalidade de atendimento (`entrega` ou `retirada`).
 *
 * Qualquer valor desconhecido/ausente cai em `entrega` (comportamento padrão do
 * cardápio). Só o checkout usa o valor para decidir se cobra a taxa e exige o
 * endereço — a sacola usa para esconder a seção de frete na retirada.
 */
const orderTypeStore = createStoredValue<OrderDeliveryType>({
  key: ORDER_TYPE_STORAGE_KEY,
  empty: "entrega",
  parse: (raw) => (raw === "retirada" ? "retirada" : "entrega"),
  serialize: (value) => value,
});


// Catálogo mock — usado APENAS como fallback retrocompatível para itens já
// persistidos no localStorage antes da vitrine dinâmica. Produtos reais
// chegam via snapshot gravado no próprio CartItem (productName/basePrice/...).
const productById = new Map(products.map((product) => [product.id, product]));

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function calcUnitPrice(base: number, opts: ProductOption[]) {
  return base + opts.reduce((acc, o) => acc + (o?.price ?? 0), 0);
}

/** Resolve o preço base: snapshot do item → catálogo mock → 0. */
function resolveBasePrice(productId: string, snapshotBase?: number): number {
  if (typeof snapshotBase === "number" && Number.isFinite(snapshotBase)) {
    return snapshotBase;
  }
  return productById.get(productId)?.preco ?? 0;
}


function normalizeOptions(opts: unknown): ProductOption[] {
  if (!Array.isArray(opts)) return [];
  return opts
    .filter(
      (o): o is ProductOption =>
        typeof o === "object" &&
        o !== null &&
        typeof (o as ProductOption).id === "string" &&
        typeof (o as ProductOption).name === "string" &&
        typeof (o as ProductOption).price === "number"
    )
    .map((o) => ({ id: o.id, name: o.name, price: o.price }));
}

function sameOptions(a: ProductOption[], b: ProductOption[]) {
  if (a.length !== b.length) return false;
  const sa = [...a].map((o) => o.id).sort().join("|");
  const sb = [...b].map((o) => o.id).sort().join("|");
  return sa === sb;
}

function sameNotes(a?: string, b?: string) {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Campos de snapshot opcionais herdados/comunicados junto do item. */
interface ItemSnapshot {
  productName?: string;
  basePrice?: number;
  imageUrl?: string;
  establishmentId?: string;
  categoryName?: string;
  /** Sabores do item meio a meio (exatamente 2; o 1º é o próprio produto). */
  halfHalfFlavors?: HalfHalfFlavor[];
}

function withTotals(
  productId: string,
  quantidade: number,
  selectedOptions: ProductOption[],
  notes?: string,
  id?: string,
  snapshot?: ItemSnapshot
): CartItem {
  const normalizedHalfHalf = normalizeHalfHalfFlavors(
    snapshot?.halfHalfFlavors
  );
  // O modelo atual exige que o próprio produto seja um dos sabores (ele é
  // sempre o 1º). Snapshots antigos, em que o produto era apenas o item
  // "pai", deixam de ser meio a meio e voltam a ser um item inteiro.
  const halfHalfFlavors =
    normalizedHalfHalf?.some((flavor) => flavor.id === productId)
      ? normalizedHalfHalf
      : undefined;
  // Meio a meio: o preço base é derivado dos sabores (sabor mais caro). O
  // snapshot persistido tem prioridade para manter o valor visto pelo cliente.
  const base =
    typeof snapshot?.basePrice === "number" && Number.isFinite(snapshot.basePrice)
      ? snapshot.basePrice
      : halfHalfFlavors
        ? (resolveHalfHalfBasePrice(halfHalfFlavors) ?? 0)
        : resolveBasePrice(productId);
  const unitPrice = calcUnitPrice(base, selectedOptions);
  const cleanNotes = notes?.trim() ? notes.trim() : undefined;
  const fallback = productById.get(productId);
  return {
    id: id ?? makeId(),
    productId,
    quantidade,
    selectedOptions,
    notes: cleanNotes,
    unitPrice,
    itemTotalPrice: unitPrice * quantidade,
    // Snapshot persistido com o item — permite exibir nome/imagem/loja no
    // checkout sem recarregar o catálogo (e sem depender do mock).
    productName: snapshot?.productName ?? fallback?.nome,
    basePrice: base,
    imageUrl: snapshot?.imageUrl ?? fallback?.image_url,
    establishmentId: snapshot?.establishmentId,
    categoryName: snapshot?.categoryName ?? fallback?.categoria,
    ...(halfHalfFlavors ? { halfHalfFlavors } : {}),
  };
}

function isValidCartItem(value: unknown): value is CartItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CartItem> & {
    productId?: unknown;
    quantidade?: unknown;
  };
  if (typeof item.productId !== "string" || !item.productId) return false;
  if (typeof item.quantidade !== "number" || !Number.isInteger(item.quantidade) || item.quantidade <= 0) return false;
  // Item válido se: tem snapshot (produto real da vitrine) OU pertence ao
  // catálogo mock (itens antigos persistidos antes da migração).
  const hasSnapshot = typeof item.productName === "string" && item.productName.length > 0;
  if (!hasSnapshot && !productById.has(item.productId)) return false;
  return true;
}

function migrateItem(raw: unknown): CartItem | null {
  if (!isValidCartItem(raw)) return null;
  const item = raw as Partial<CartItem> & { productId: string; quantidade: number };
  const selectedOptions = normalizeOptions((item as CartItem).selectedOptions);
  const notes = typeof item.notes === "string" ? item.notes : undefined;
  const id = typeof item.id === "string" && item.id ? item.id : makeId();
  const snapshot: ItemSnapshot = {
    productName:
      typeof item.productName === "string" && item.productName
        ? item.productName
        : undefined,
    basePrice:
      typeof item.basePrice === "number" && Number.isFinite(item.basePrice)
        ? item.basePrice
        : undefined,
    imageUrl:
      typeof item.imageUrl === "string" && item.imageUrl ? item.imageUrl : undefined,
    establishmentId:
      typeof item.establishmentId === "string" && item.establishmentId
        ? item.establishmentId
        : undefined,
    categoryName:
      typeof item.categoryName === "string" && item.categoryName
        ? item.categoryName
        : undefined,
    // Itens meio a meio persistidos: normaliza para exatamente 2 sabores
    // válidos (itens antigos/corrompidos viram um item comum).
    halfHalfFlavors: normalizeHalfHalfFlavors(item.halfHalfFlavors),
  };
  return withTotals(
    item.productId,
    item.quantidade,
    selectedOptions,
    notes,
    id,
    snapshot
  );
}


// ---------------------------------------------------------------------------
// Store externo persistido em localStorage.
// O snapshot é sempre uma referência estável (imutável) para que o
// useSyncExternalStore não entre em loop de renderização.
// ---------------------------------------------------------------------------
let snapshot: CartItem[] = EMPTY_ITEMS;
let hasLoaded = false;
const listeners = new Set<() => void>();
/** Quantos componentes assinam o carrinho (um único listener de `storage`). */
let cartSubscribers = 0;

function notify() {
  listeners.forEach((listener) => listener());
}

/** Sincroniza o carrinho entre abas (registrado uma única vez por store). */
function handleCartStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY) return;
  hasLoaded = false;
  snapshot = EMPTY_ITEMS;
  loadFromStorage();
  notify();
}

function loadFromStorage(): CartItem[] {
  if (hasLoaded) return snapshot;
  hasLoaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed
          .map(migrateItem)
          .filter((i): i is CartItem => i !== null);
        snapshot = valid.length > 0 ? valid : EMPTY_ITEMS;
      }
    }
  } catch {
    // Storage corrompido ou indisponível: mantém carrinho vazio.
    snapshot = EMPTY_ITEMS;
  }
  return snapshot;
}

function persist(items: CartItem[]) {
  snapshot = items;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignora falhas de quota/unavailable storage.
  }
  notify();
}

function commit(mutator: (current: CartItem[]) => CartItem[]) {
  const current = loadFromStorage();
  const next = mutator(current);
  if (next === current) return;
  persist(next);
}

export interface AddCustomItemInput {
  productId: string;
  selectedOptions?: ProductOption[];
  notes?: string;
  quantidade?: number;
  /**
   * Snapshot do produto (recomendado para produtos reais da vitrine):
   * permite calcular totais e exibir o item no checkout sem consultar o
   * catálogo mock. Se omitted, o preço é resolvido via `lib/mockData`
   * (compatibilidade retroativa).
   */
  productName?: string;
  basePrice?: number;
  imageUrl?: string;
  establishmentId?: string;
  categoryName?: string;
  /**
   * Sabores do item "meio a meio" (exatamente 2, sendo o 1º o próprio produto
   * deste item). Quando informado, `basePrice` deve ser o preço do sabor mais
   * caro (ou 0 quando "Sob Consulta").
   */
  halfHalfFlavors?: HalfHalfFlavor[];
}

const addCustomItem = (input: AddCustomItemInput) => {
  const halfHalfFlavors = normalizeHalfHalfFlavors(input.halfHalfFlavors);
  const snapshot: ItemSnapshot = {
    productName: input.productName?.trim() || undefined,
    basePrice:
      typeof input.basePrice === "number" && Number.isFinite(input.basePrice)
        ? input.basePrice
        : undefined,
    imageUrl: input.imageUrl?.trim() || undefined,
    establishmentId: input.establishmentId?.trim() || undefined,
    categoryName: input.categoryName?.trim() || undefined,
    halfHalfFlavors,
  };

  // Validação: produto conhecido se tiver snapshot OU existir no catálogo mock.
  const known =
    (snapshot.productName !== undefined &&
      (snapshot.basePrice !== undefined || halfHalfFlavors !== undefined)) ||
    productById.has(input.productId);
  if (!known) return;

  const qty = input.quantidade && input.quantidade > 0 ? Math.min(99, Math.floor(input.quantidade)) : 1;
  const opts = normalizeOptions(input.selectedOptions);
  const notes = input.notes?.trim() ? input.notes.trim() : undefined;
  commit((current) => {
    // Linhas só se agrupam quando produto, opcionais, observação E sabores
    // (meio a meio) são iguais — duas metades diferentes viram linhas distintas.
    const existing = current.find(
      (item) =>
        item.productId === input.productId &&
        sameOptions(item.selectedOptions ?? [], opts) &&
        sameNotes(item.notes, notes) &&
        sameHalfHalfFlavors(item.halfHalfFlavors, halfHalfFlavors)
    );
    if (existing) {
      return current.map((item) =>
        item.id === existing.id
          ? withTotals(
              item.productId,
              Math.min(99, item.quantidade + qty),
              item.selectedOptions ?? [],
              item.notes,
              item.id,
              {
                productName: item.productName,
                basePrice: item.basePrice,
                imageUrl: item.imageUrl,
                establishmentId: item.establishmentId,
                categoryName: item.categoryName,
                halfHalfFlavors: item.halfHalfFlavors,
              }
            )
          : item
      );
    }
    return [...current, withTotals(input.productId, qty, opts, notes, undefined, snapshot)];
  });
};

const addItem = (product: Product, quantity?: number) => {
  addCustomItem({
    productId: product.id,
    productName: product.nome,
    basePrice: product.preco,
    imageUrl: product.image_url,
    establishmentId: product.establishmentId,
    categoryName: product.category ?? product.categoria,
    // Quantidade escolhida pelo cliente no seletor do card (padrão: 1).
    quantidade: quantity && quantity > 0 ? Math.floor(quantity) : 1,
  });
};


const removeItem = (productId: string) => {
  commit((current) => {
    // Remove 1 unidade da última linha desse produto (compatível com ProductCard).
    const idx = [...current].map((i) => i.productId).lastIndexOf(productId);
    if (idx === -1) return current;
    const target = current[idx];
    const next = current
      .map((item) =>
        item.id === target.id
          ? withTotals(
              item.productId,
              item.quantidade - 1,
              item.selectedOptions ?? [],
              item.notes,
              item.id,
              {
                productName: item.productName,
                basePrice: item.basePrice,
                imageUrl: item.imageUrl,
                establishmentId: item.establishmentId,
                categoryName: item.categoryName,
                halfHalfFlavors: item.halfHalfFlavors,
              }
            )
          : item
      )
      .filter((item) => item.quantidade > 0);
    return next.length > 0 ? next : EMPTY_ITEMS;
  });
};


const removeLine = (lineId: string) => {
  commit((current) => {
    const next = current.filter((item) => item.id !== lineId);
    return next.length > 0 ? next : EMPTY_ITEMS;
  });
};

/**
 * Define a quantidade de uma linha do carrinho.
 * Quantidades <= 0 removem a linha (comportamento equivalente a `removeLine`).
 */
const setLineQuantity = (lineId: string, quantity: number) => {
  const qty = Math.floor(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    removeLine(lineId);
    return;
  }
  commit((current) => {
    let changed = false;
    const next = current
      .map((item) => {
        if (item.id !== lineId) return item;
        changed = true;
        return withTotals(
          item.productId,
          Math.min(99, qty),
          item.selectedOptions ?? [],
          item.notes,
          item.id,
          {
            productName: item.productName,
            basePrice: item.basePrice,
            imageUrl: item.imageUrl,
            establishmentId: item.establishmentId,
            categoryName: item.categoryName,
            halfHalfFlavors: item.halfHalfFlavors,
          }
        );
      })
      .filter((item) => item.quantidade > 0);
    if (!changed) return current;
    return next.length > 0 ? next : EMPTY_ITEMS;
  });
};

const clearCart = () => {
  // Idempotente e SEMPRE persistido: não retorna cedo com base apenas no
  // snapshot em memória, pois outra aba pode ter deixado itens no localStorage.
  // Chamado após o pedido ser aceito pela API — o carrinho precisa ficar
  // realmente vazio (sem nenhuma referência ao pedido anterior).
  persist(EMPTY_ITEMS);
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Sincroniza entre abas do mesmo navegador (um único listener para o store).
  cartSubscribers += 1;
  if (cartSubscribers === 1) {
    window.addEventListener("storage", handleCartStorage);
  }
  return () => {
    listeners.delete(listener);
    cartSubscribers = Math.max(0, cartSubscribers - 1);
    if (cartSubscribers === 0) {
      window.removeEventListener("storage", handleCartStorage);
    }
  };
}

const getSnapshot = (): CartItem[] =>
  typeof window === "undefined" ? EMPTY_ITEMS : loadFromStorage();

const getServerSnapshot = (): CartItem[] => EMPTY_ITEMS;

// Detecta a hidratação sem efeitos colaterais (padrão recomendado pelo React).
// `getSnapshot`/`getServerSnapshot` ficam no escopo do módulo (referência
// estável): funções inline recriadas a cada render fazem o React revalidar o
// snapshot em toda renderização e podem alimentar loops de re-render.
const subscribeNothing = (listener: () => void) => {
  void listener;
  return () => undefined;
};
const getHydratedSnapshot = () => true;
const getHydratedServerSnapshot = () => false;

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------
interface CartContextValue {
  items: CartItem[];
  itemCount: number;
  total: number;
  isHydrated: boolean;
  /** CEP (somente dígitos) informado na sacola; chega pré-preenchido ao checkout. */
  deliveryCep: string;
  setDeliveryCep: (cep: string) => void;
  /**
   * Endereço salvo na sacola (usado no cálculo do frete) — o checkout abre com
   * esses dados já preenchidos para o cliente só revisar.
   */
  deliveryAddress: CartDeliveryAddress | null;
  setDeliveryAddress: (address: CartDeliveryAddress | null) => void;
  /**
   * Modalidade escolhida (entrega em casa ou retirada no balcão). A sacola e o
   * checkout compartilham o mesmo valor — trocar em um reflete no outro.
   */
  orderType: OrderDeliveryType;
  setOrderType: (type: OrderDeliveryType) => void;
  addItem: (product: Product, quantity?: number) => void;
  addCustomItem: (input: AddCustomItemInput) => void;
  removeItem: (productId: string) => void;
  removeLine: (lineId: string) => void;
  setLineQuantity: (lineId: string, quantity: number) => void;
  clearCart: () => void;
  quantityOf: (productId: string) => number;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const items = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );
  const isHydrated = useSyncExternalStore(
    subscribeNothing,
    getHydratedSnapshot,
    getHydratedServerSnapshot
  );
  const deliveryCep = useSyncExternalStore(
    deliveryCepStore.subscribe,
    deliveryCepStore.getSnapshot,
    deliveryCepStore.getServerSnapshot
  );
  const deliveryAddress = useSyncExternalStore(
    deliveryAddressStore.subscribe,
    deliveryAddressStore.getSnapshot,
    deliveryAddressStore.getServerSnapshot
  );
  const orderType = useSyncExternalStore(
    orderTypeStore.subscribe,
    orderTypeStore.getSnapshot,
    orderTypeStore.getServerSnapshot
  );

  const value = useMemo<CartContextValue>(() => {
    const itemCount = items.reduce((acc, item) => acc + item.quantidade, 0);
    // (preço base + adicionais) * quantidade — usa itemTotalPrice já calculado.
    const total = items.reduce((acc, item) => {
      if (typeof item.itemTotalPrice === "number") return acc + item.itemTotalPrice;
      // Fallback: recalcula a partir do snapshot (produto real) ou do mock.
      const base =
        typeof item.basePrice === "number"
          ? item.basePrice
          : item.halfHalfFlavors
            ? (resolveHalfHalfBasePrice(item.halfHalfFlavors) ?? 0)
            : productById.get(item.productId)?.preco ?? 0;
      const unit = calcUnitPrice(base, item.selectedOptions ?? []);
      return acc + unit * item.quantidade;
    }, 0);

    return {
      items,
      itemCount,
      total,
      isHydrated,
      deliveryCep,
      setDeliveryCep: setDeliveryCepValue,
      deliveryAddress,
      setDeliveryAddress: deliveryAddressStore.set,
      orderType,
      setOrderType: orderTypeStore.set,
      addItem,
      addCustomItem,
      removeItem,
      removeLine,
      setLineQuantity,
      clearCart,
      quantityOf: (productId: string) =>
        items
          .filter((item) => item.productId === productId)
          .reduce((acc, item) => acc + item.quantidade, 0),
    };
  }, [items, isHydrated, deliveryCep, deliveryAddress, orderType]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart deve ser usado dentro de um <CartProvider>.");
  }
  return context;
}
