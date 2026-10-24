"use client";

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CartItem, Product, ProductOption } from "@/lib/types";
import { parseCep } from "@/lib/delivery";
import { products } from "@/lib/mockData";

const STORAGE_KEY = "@delivery:cart";

/**
 * CEP de entrega escolhido na sacola. Fica no contexto (e no localStorage)
 * para chegar já preenchido ao checkout, sem o cliente precisar digitá-lo
 * novamente. Guardamos apenas os 8 dígitos normalizados.
 */
const DELIVERY_CEP_STORAGE_KEY = "@delivery:delivery-cep";

const EMPTY_ITEMS: CartItem[] = [];

const deliveryCepListeners = new Set<() => void>();
let deliveryCepSnapshot = "";
let deliveryCepLoaded = false;

function loadDeliveryCep(): string {
  if (typeof window === "undefined") return "";
  if (deliveryCepLoaded) return deliveryCepSnapshot;

  deliveryCepLoaded = true;
  try {
    deliveryCepSnapshot =
      parseCep(window.localStorage.getItem(DELIVERY_CEP_STORAGE_KEY)) ?? "";
  } catch {
    // Storage indisponível (modo privado, quota etc.): mantém vazio.
    deliveryCepSnapshot = "";
  }
  return deliveryCepSnapshot;
}

function notifyDeliveryCep() {
  for (const listener of deliveryCepListeners) listener();
}

function subscribeDeliveryCep(listener: () => void) {
  deliveryCepListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== DELIVERY_CEP_STORAGE_KEY) return;
    deliveryCepLoaded = false;
    deliveryCepSnapshot = "";
    loadDeliveryCep();
    notifyDeliveryCep();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    deliveryCepListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

const getDeliveryCepSnapshot = (): string =>
  typeof window === "undefined" ? "" : loadDeliveryCep();

const getDeliveryCepServerSnapshot = (): string => "";

/** Persiste o CEP informado na sacola (somente 8 dígitos; vazio limpa). */
function setDeliveryCepValue(value: string) {
  const normalized = parseCep(value) ?? "";
  deliveryCepLoaded = true;
  deliveryCepSnapshot = normalized;

  try {
    if (normalized) {
      window.localStorage.setItem(DELIVERY_CEP_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(DELIVERY_CEP_STORAGE_KEY);
    }
  } catch {
    // Falha de storage não deve interromper a sacola.
  }
  notifyDeliveryCep();
}

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
}

function withTotals(
  productId: string,
  quantidade: number,
  selectedOptions: ProductOption[],
  notes?: string,
  id?: string,
  snapshot?: ItemSnapshot
): CartItem {
  const base = resolveBasePrice(productId, snapshot?.basePrice);
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

function notify() {
  listeners.forEach((listener) => listener());
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
}

const addCustomItem = (input: AddCustomItemInput) => {
  const snapshot: ItemSnapshot = {
    productName: input.productName?.trim() || undefined,
    basePrice:
      typeof input.basePrice === "number" && Number.isFinite(input.basePrice)
        ? input.basePrice
        : undefined,
    imageUrl: input.imageUrl?.trim() || undefined,
    establishmentId: input.establishmentId?.trim() || undefined,
    categoryName: input.categoryName?.trim() || undefined,
  };

  // Validação: produto conhecido se tiver snapshot OU existir no catálogo mock.
  const known =
    (snapshot.productName !== undefined && snapshot.basePrice !== undefined) ||
    productById.has(input.productId);
  if (!known) return;

  const qty = input.quantidade && input.quantidade > 0 ? Math.min(99, Math.floor(input.quantidade)) : 1;
  const opts = normalizeOptions(input.selectedOptions);
  const notes = input.notes?.trim() ? input.notes.trim() : undefined;
  commit((current) => {
    const existing = current.find(
      (item) =>
        item.productId === input.productId &&
        sameOptions(item.selectedOptions ?? [], opts) &&
        sameNotes(item.notes, notes)
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
  // Sincroniza entre abas do mesmo navegador.
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      hasLoaded = false;
      snapshot = EMPTY_ITEMS;
      loadFromStorage();
      notify();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

const getSnapshot = (): CartItem[] =>
  typeof window === "undefined" ? EMPTY_ITEMS : loadFromStorage();

const getServerSnapshot = (): CartItem[] => EMPTY_ITEMS;

// Detecta a hidratação sem efeitos colaterais (padrão recomendado pelo React).
const subscribeNothing = (listener: () => void) => {
  void listener;
  return () => undefined;
};

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
    () => true,
    () => false
  );
  const deliveryCep = useSyncExternalStore(
    subscribeDeliveryCep,
    getDeliveryCepSnapshot,
    getDeliveryCepServerSnapshot
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
  }, [items, isHydrated, deliveryCep]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart deve ser usado dentro de um <CartProvider>.");
  }
  return context;
}
