/**
 * Bandeiras de Cartão de Crédito / Débito aceitas NA ENTREGA (maquininha).
 *
 * Módulo puro (sem dependências de servidor): usado pelo painel
 * (`/painel/configuracoes`), por `PUT /api/establishment`, por `/api/menu`,
 * pelo checkout (`CheckoutForm`) e por `POST /api/orders`.
 *
 * Regra: a modalidade é SEMPRE presencial — o entregador leva a maquininha e
 * passa o cartão do cliente. Nada passa pelo gateway online (PIX Asaas).
 *
 * As listas da loja são separadas por tipo (`accepted_credit_brands` e
 * `accepted_debit_brands`): cada tipo pode ter as suas próprias bandeiras. Lista
 * vazia = loja não aceita aquele tipo (quando as duas estão vazias a loja ainda
 * não configurou nada e o checkout não exige bandeira).
 */

/** Valor de `orders.payment_method` para pagamento com cartão na entrega. */
export const CARD_PAYMENT_METHOD = "cartao";

/** Tipo do cartão gravado em `orders.card_type`. */
export type CardType = "credito" | "debito";

/** Tipos de cartão suportados, na ordem exibida no checkout. */
export const CARD_TYPES: readonly CardType[] = ["credito", "debito"] as const;

/** Rótulos de exibição de cada tipo. */
export const CARD_TYPE_LABELS: Record<CardType, string> = {
  credito: "Crédito",
  debito: "Débito",
};

/**
 * Bandeiras de mercado oferecidas no painel. O lojista pode marcar/desmarcar
 * essas opções e ainda cadastrar bandeiras customizadas.
 */
export const CARD_BRAND_OPTIONS = [
  "Visa",
  "Mastercard",
  "Elo",
  "American Express",
  "Hipercard",
  "Diners Club",
  "JCB",
  "UnionPay",
] as const;

/** Limite de bandeiras cadastradas por tipo (evita payload abusivo). */
export const MAX_CARD_BRANDS = 20;

/** Limite de caracteres do nome de uma bandeira (inclusive customizada). */
export const MAX_CARD_BRAND_NAME_LENGTH = 40;

/**
 * Normaliza o nome de uma bandeira: remove espaços repetidos, apara as pontas
 * e limita o tamanho. Retorna `null` quando não sobra nada útil.
 */
export function normalizeCardBrandName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, MAX_CARD_BRAND_NAME_LENGTH);
}

/**
 * Normaliza a lista vinda do banco/API (jsonb, array ou string JSON) numa
 * lista de nomes únicos: apara, remove vazios/duplicados (sem diferenciar
 * maiúsculas) e limita a quantidade.
 *
 * Qualquer formato inesperado vira `[]` — ou seja, loja sem bandeiras
 * cadastradas para aquele tipo.
 */
export function normalizeCardBrands(value: unknown): string[] {
  let source: unknown = value;

  // Bases legadas/payloads antigos podem trazer a lista como string JSON.
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return [];
    }
  }

  if (!Array.isArray(source)) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of source) {
    const name = normalizeCardBrandName(entry);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_CARD_BRANDS) break;
  }
  return names;
}

/**
 * Confere se a loja aceita a bandeira informada e devolve o nome no padrão
 * gravado pela loja (comparação sem diferenciar maiúsculas).
 *
 * `null` = bandeira não aceita (ou lista vazia). Usado pelo servidor em
 * `POST /api/orders`, que nunca confia na lista enviada pelo navegador.
 */
export function matchAcceptedCardBrand(
  accepted: unknown,
  brand: unknown
): string | null {
  const name = normalizeCardBrandName(brand);
  if (!name) return null;
  const key = name.toLowerCase();
  return (
    normalizeCardBrands(accepted).find((item) => item.toLowerCase() === key) ??
    null
  );
}

/**
 * Normaliza o tipo do cartão. Aceita o valor gravado (`credito`/`debito`) e
 * variações com acento/maiúsculas vindas de bases antigas ou de integrações.
 *
 * `null` = tipo ausente/desconhecido.
 */
export function normalizeCardType(value: unknown): CardType | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key === "credito" || key === "crédito" || key === "credit") {
    return "credito";
  }
  if (key === "debito" || key === "débito" || key === "debit") {
    return "debito";
  }
  return null;
}

/** Rótulo do tipo ("Crédito"/"Débito"); string vazia quando ausente. */
export function cardTypeLabel(value: unknown): string {
  const type = normalizeCardType(value);
  return type ? CARD_TYPE_LABELS[type] : "";
}

/**
 * Detalhe curto do pagamento com cartão ("Crédito · Visa"), usado nos rótulos
 * do painel/WhatsApp. Retorna string vazia quando não há tipo nem bandeira.
 */
export function cardPaymentDetailLabel(
  cardType?: string | null,
  cardBrand?: string | null
): string {
  const type = cardTypeLabel(cardType);
  const brand = normalizeCardBrandName(cardBrand);
  return [type, brand].filter(Boolean).join(" · ");
}
