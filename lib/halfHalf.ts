/**
 * Regras do item "meio a meio" (pizzas com dois sabores).
 *
 * Modelo adotado:
 * - O produto marcado com `allow_half_half` é um SABOR que pode ser vendido
 *   inteiro (1 sabor, padrão) ou meio a meio (2 sabores). No meio a meio, o
 *   próprio produto clicado é sempre o 1º sabor e o cliente escolhe apenas o
 *   2º, entre produtos ativos da MESMA categoria que também tenham
 *   `allow_half_half` habilitado.
 * - O preço unitário do meio a meio é o do sabor mais caro entre os dois
 *   (`HalfHalfPriceRule = "highest"`), somando-se os adicionais normalmente.
 * - Se algum dos sabores não tiver preço fechado (0/ausente), o item fica
 *   "Sob Consulta" no modo catálogo; no checkout tradicional o pedido é
 *   recusado para evitar cobrança incorreta (ajuste o preço no cardápio).
 *
 * O módulo é compartilhado por componentes client (modal/sacola/checkout) e
 * pelas rotas de API, portanto não usa APIs exclusivas do navegador.
 */

import type {
  HalfHalfFlavor,
  HalfHalfPriceRule,
  HalfHalfSelection,
  Product,
} from "./types";

/** Quantidade obrigatória de sabores em um item meio a meio. */
export const HALF_HALF_FLAVOR_COUNT = 2;

/** Regra padrão de mercado: cobra o valor do sabor mais caro. */
export const DEFAULT_HALF_HALF_PRICE_RULE: HalfHalfPriceRule = "highest";

/**
 * Normaliza uma lista arbitrária (localStorage/jsonb) em `HalfHalfFlavor[]`.
 * Devolve `undefined` quando não há exatamente 2 sabores válidos e distintos —
 * assim itens antigos/corrompidos não quebram o carrinho.
 */
export function normalizeHalfHalfFlavors(
  value: unknown
): HalfHalfFlavor[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const flavors: HalfHalfFlavor[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Partial<HalfHalfFlavor>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    const price = Number(candidate.price);

    if (!id || !name || !Number.isFinite(price)) continue;
    if (seen.has(id)) continue;

    seen.add(id);
    flavors.push({ id, name, price });

    if (flavors.length === HALF_HALF_FLAVOR_COUNT) break;
  }

  return flavors.length === HALF_HALF_FLAVOR_COUNT ? flavors : undefined;
}

/**
 * Converte um produto do cardápio no snapshot de sabor usado no meio a meio.
 * Devolve `null` quando o produto não tem id/nome válidos.
 */
export function toHalfHalfFlavor(
  product:
    | Pick<Product, "id" | "nome" | "preco">
    | null
    | undefined
): HalfHalfFlavor | null {
  if (!product) return null;
  const id = product.id?.trim();
  const name = product.nome?.trim();
  if (!id || !name) return null;
  const price = Number(product.preco);
  return { id, name, price: Number.isFinite(price) ? price : 0 };
}

/**
 * Monta o par de sabores do meio a meio: o produto clicado é sempre o 1º sabor
 * e `second` (quando escolhido) entra como 2º. Devolve `undefined` enquanto o
 * 2º sabor não foi escolhido ou quando ele repete o 1º.
 */
export function buildHalfHalfFlavors(
  first: HalfHalfFlavor | null | undefined,
  second: HalfHalfFlavor | null | undefined
): HalfHalfFlavor[] | undefined {
  if (!first || !second) return undefined;
  return normalizeHalfHalfFlavors([first, second]);
}

/**
 * Indica se `candidate` pode ser o 2º sabor de `sourceId`: precisa ser outro
 * produto, estar habilitado para meio a meio e não estar esgotado. A categoria
 * é comparada pelo chamador (a vitrine já agrupa os itens por categoria).
 */
export function isHalfHalfCompanion(
  candidate: Pick<
    Product,
    "id" | "allow_half_half" | "track_stock" | "stock_quantity"
  >,
  sourceId: string | null | undefined
): boolean {
  if (!candidate.id || candidate.id === sourceId) return false;
  if (candidate.allow_half_half !== true) return false;
  if (candidate.track_stock === true && (candidate.stock_quantity ?? 0) <= 0) {
    return false;
  }
  return true;
}

/**
 * Preço base de um meio a meio segundo a regra configurada. Devolve `null`
 * quando a seleção é inválida ou quando algum sabor está "Sob Consulta".
 */
export function resolveHalfHalfBasePrice(
  flavors: readonly HalfHalfFlavor[] | null | undefined,
  rule: HalfHalfPriceRule = DEFAULT_HALF_HALF_PRICE_RULE
): number | null {
  const normalized = normalizeHalfHalfFlavors(flavors);
  if (!normalized) return null;
  if (normalized.some((flavor) => !(flavor.price > 0))) return null;

  // Única regra por enquanto: sabor mais caro. Novas regras (ex.: média,
  // percentual por sabor) entram aqui sem alterar os chamadores.
  void rule;
  return Math.max(...normalized.map((flavor) => flavor.price));
}

/** Rótulo curto dos sabores (ex.: "Meio Calabresa / Meio Frango"). */
export function halfHalfFlavorsLabel(
  flavors: readonly HalfHalfFlavor[] | null | undefined
): string {
  const normalized = normalizeHalfHalfFlavors(flavors);
  if (!normalized) return "";
  return normalized.map((flavor) => `Meio ${flavor.name}`).join(" / ");
}

/**
 * Nome do item como aparece na sacola/pedido. Sem meio a meio devolve o nome
 * original; com sabores monta "Pizza Grande (Meio Calabresa / Meio Frango)".
 */
export function withHalfHalfLabel(
  baseName: string | null | undefined,
  flavors: readonly HalfHalfFlavor[] | null | undefined
): string {
  const name = baseName?.trim() || "Item";
  const label = halfHalfFlavorsLabel(flavors);
  return label ? `${name} (${label})` : name;
}

/** Snapshot estruturado gravado em `orders.items[].half_half`. */
export function toHalfHalfSelection(
  flavors: readonly HalfHalfFlavor[] | null | undefined,
  rule: HalfHalfPriceRule = DEFAULT_HALF_HALF_PRICE_RULE
): HalfHalfSelection | undefined {
  const normalized = normalizeHalfHalfFlavors(flavors);
  if (!normalized) return undefined;
  return { flavors: normalized, price_rule: rule };
}

/**
 * Compara duas seleções pela ordem dos ids (ordem de escolha não importa para
 * decidir se duas linhas do carrinho podem ser agrupadas).
 */
export function sameHalfHalfFlavors(
  a: readonly HalfHalfFlavor[] | null | undefined,
  b: readonly HalfHalfFlavor[] | null | undefined
): boolean {
  const first = normalizeHalfHalfFlavors(a);
  const second = normalizeHalfHalfFlavors(b);
  // Sem sabores nos dois lados = item comum (pode agrupar normalmente).
  if (!first || !second) return !first && !second;
  const key = (flavors: HalfHalfFlavor[]) =>
    [...flavors].map((flavor) => flavor.id).sort().join("|");
  return key(first) === key(second);
}
