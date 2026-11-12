/**
 * Vale-Refeição / Vale-Alimentação aceitos NA ENTREGA (maquininha presencial).
 *
 * Módulo puro (sem dependências de servidor): usado pelo painel
 * (`/painel/configuracoes`), por `PUT /api/establishment`, por `/api/menu`,
 * pelo checkout (`CheckoutForm`) e por `POST /api/orders`.
 *
 * Regra: a modalidade é SEMPRE presencial — o entregador leva a maquininha e
 * cobra no cartão de vale do cliente. Nada passa pelo gateway online (PIX
 * Asaas) nem pelo split de pagamentos.
 */

/** Valor de `orders.payment_method` para pagamento com vale na entrega. */
export const MEAL_VOUCHER_PAYMENT_METHOD = "vale_refeicao";

/**
 * Bandeiras de mercado oferecidas no painel. O lojista pode marcar/desmarcar
 * essas opções e ainda cadastrar bandeiras customizadas.
 */
export const MEAL_VOUCHER_OPTIONS = [
  "Alelo",
  "Sodexo / Pluxee",
  "Ticket",
  "VR Benefícios",
  "Ben Visa Vale",
  "Greencard",
  "Verocard",
] as const;

/** Limite de bandeiras cadastradas por loja (evita payload abusivo). */
export const MAX_MEAL_VOUCHERS = 20;

/** Limite de caracteres do nome de uma bandeira (inclusive customizada). */
export const MAX_MEAL_VOUCHER_NAME_LENGTH = 40;

/**
 * Normaliza o nome de uma bandeira: remove espaços repetidos, apara as pontas
 * e limita o tamanho. Retorna `null` quando não sobra nada útil.
 */
export function normalizeMealVoucherName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, MAX_MEAL_VOUCHER_NAME_LENGTH);
}

/**
 * Normaliza a lista vinda do banco/API (jsonb, array ou string JSON) numa
 * lista de nomes únicos: apara, remove vazios/duplicados (sem diferenciar
 * maiúsculas) e limita a quantidade.
 *
 * Qualquer formato inesperado vira `[]` — ou seja, loja sem vale na entrega.
 */
export function normalizeMealVouchers(value: unknown): string[] {
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
    const name = normalizeMealVoucherName(entry);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_MEAL_VOUCHERS) break;
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
export function matchAcceptedMealVoucher(
  accepted: unknown,
  voucher: unknown
): string | null {
  const name = normalizeMealVoucherName(voucher);
  if (!name) return null;
  const key = name.toLowerCase();
  return (
    normalizeMealVouchers(accepted).find(
      (item) => item.toLowerCase() === key
    ) ?? null
  );
}

/**
 * Rótulo único da modalidade exibido no checkout, no WhatsApp, no painel e em
 * "Meus Pedidos": deixa explícito que o pagamento é na entrega e qual
 * maquininha o entregador precisa levar.
 *
 * Ex.: "Vale-Refeição (Alelo) - na entrega"
 */
export function mealVoucherPaymentLabel(voucher?: string | null): string {
  const name = normalizeMealVoucherName(voucher);
  return name
    ? `Vale-Refeição (${name}) - na entrega`
    : "Vale-Refeição - na entrega";
}
