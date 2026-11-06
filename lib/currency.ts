/**
 * Helpers de entrada monetária (BRL) usados nos formulários do painel.
 *
 * Fluxo: o usuário digita em formato brasileiro amigável (`26,90`) e o ponto do
 * teclado numérico mobile é convertido automaticamente para vírgula. Antes de
 * enviar para a API/banco, `parseCurrencyInput` devolve o número no padrão
 * JavaScript/PostgreSQL (`26.9`).
 */

/** Casas decimais aceitas no input (centavos). */
const DECIMAL_PLACES = 2;

/** Limite de dígitos na parte inteira (evita valores digitados por engano). */
const MAX_INTEGER_DIGITS = 9;

/** Fator usado no arredondamento em centavos (`10 ** 2`). */
const DECIMAL_FACTOR = 10 ** DECIMAL_PLACES;

/**
 * Limpa o texto digitado/colado deixando apenas dígitos e vírgulas.
 *
 * - Descarta símbolos (`R$`), espaços, letras e sinais;
 * - Remove o ponto de milhar quando o texto já traz vírgula (`1.234,56`);
 * - Converte os demais pontos em vírgula (`.` do teclado numérico mobile).
 */
function toCommaString(raw: string): string {
  let value = raw.trim();
  if (value.includes(",") && /\.\d{3}(\D|$)/.test(value)) {
    value = value.replace(/\./g, "");
  }
  return value.replace(/\./g, ",").replace(/[^\d,]/g, "");
}

/**
 * Formata progressivamente o valor digitado no campo de preço.
 *
 * Exemplos:
 * - `"12.50"` → `"12,50"` (ponto do teclado numérico vira vírgula)
 * - `"12,505"` → `"12,50"` (no máximo 2 casas decimais)
 * - `"R$ 1.234,5"` → `"1234,5"` (milhar descartado, símbolo removido)
 * - `"abc"` → `""` (caracteres não numéricos são ignorados)
 */
export function formatCurrencyInput(raw: string): string {
  const cleaned = toCommaString(raw);
  if (!cleaned) return "";

  const [rawInteger, ...decimalParts] = cleaned.split(",");
  const integerDigits = rawInteger
    .replace(/^0+(?=\d)/, "")
    .slice(0, MAX_INTEGER_DIGITS);
  // Sem parte inteira (ex.: o usuário começou digitando ","), assume "0".
  const integerPart = integerDigits || (decimalParts.length > 0 ? "0" : "");

  if (decimalParts.length === 0) return integerPart;

  const decimalPart = decimalParts.join("").slice(0, DECIMAL_PLACES);
  return `${integerPart},${decimalPart}`;
}

/**
 * Converte o valor do input (`"12,50"`, `"12.50"`, `"R$ 1.234,56"`) para número
 * no padrão JavaScript/PostgreSQL (`12.5`), arredondado em centavos.
 *
 * Retorna `NaN` quando não há número válido.
 */
export function parseCurrencyInput(raw: string): number {
  const formatted = formatCurrencyInput(raw);
  if (!formatted) return Number.NaN;

  const [integerPart, decimalPart = ""] = formatted.split(",");
  const normalized = decimalPart
    ? `${integerPart || "0"}.${decimalPart}`
    : integerPart;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return Number.NaN;

  // Arredonda em centavos para não persistir dízimas do float.
  return Math.round(value * DECIMAL_FACTOR) / DECIMAL_FACTOR;
}

/**
 * Formata um número vindo do banco (`12.5`) para o input (`"12,50"`).
 * Usado ao abrir o formulário em modo de edição.
 */
export function formatCurrencyValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(DECIMAL_PLACES).replace(".", ",");
}
