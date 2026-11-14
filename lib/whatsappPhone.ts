/**
 * Telefones do WhatsApp no padrão brasileiro (DDI 55 + DDD + número).
 *
 * Módulo **puro** (sem imports e sem APIs de navegador) para ser usado no
 * checkout (link `wa.me`), nas rotas de API (cadastro da loja) e no envio pela
 * Evolution API (`lib/whatsapp/orderNotifications.ts` e
 * `lib/whatsapp/evolution.ts`). Uma única implementação evita que cada tela
 * aceite um formato diferente do número que vai para o WhatsApp.
 *
 * Regras aplicadas:
 * - só dígitos: máscara (`(17) 99612-9158`), `+`, espaços, traços e parênteses
 *   são descartados;
 * - zeros à esquerda (tronco/`011`) são removidos;
 * - o DDI 55 é sempre garantido no resultado;
 * - o DDD precisa existir na numeração brasileira (lista da ANATEL);
 * - celular digitado no formato antigo de 8 dígitos (`9961-2915`, começando em
 *   6-9) recebe o nono dígito (`9`) — formato usado pelo WhatsApp;
 * - telefone fixo continua aceito em `normalizeWhatsAppNumber` (12 dígitos),
 *   mas NÃO em `normalizeWhatsAppMobileNumber`: fixo não tem WhatsApp e a
 *   Evolution API responde `400 Bad Request`. Quem dispara mensagem usa a
 *   variante "mobile" para ignorar o envio de forma segura.
 */

/** DDI do Brasil, sempre presente no número normalizado. */
const BRAZIL_DDI = "55";

/**
 * DDDs em uso no Brasil (ANATEL).
 *
 * Sem esta checagem números truncados/errados (ex.: `55179...` com um dígito
 * perdido, ou `5500...`) passavam na validação de tamanho e só eram recusados
 * pela Evolution, com um `400` de resposta opaca.
 */
const VALID_BRAZILIAN_DDDS = new Set<string>([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99",
]);

/** Somente os dígitos do valor recebido (`null`/`undefined` viram ""). */
function onlyDigits(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * Celular brasileiro = 9 dígitos após o DDD, sempre começando em `9`.
 * Recebe o número NACIONAL (DDD + número), sem o DDI.
 */
function isMobileNationalNumber(national: string): boolean {
  return national.length === 11 && national[2] === "9";
}

/**
 * Normaliza o número para o formato aceito pelo WhatsApp (`wa.me` e Evolution
 * API): DDI 55 + DDD + número, apenas dígitos.
 *
 * Retorna `null` quando não é possível montar um número brasileiro válido — o
 * checkout não gera link quebrado e o envio automático é ignorado.
 */
export function normalizeWhatsAppNumber(
  raw: string | null | undefined
): string | null {
  // Zeros à esquerda (tronco/`011`) não fazem parte do número.
  const digits = onlyDigits(raw).replace(/^0+/, "");
  if (!digits) return null;

  // Até 11 dígitos é o formato nacional (DDD + número). Acima disso o número
  // precisa vir com o DDI do Brasil (é o caso de `+55 (17) 99612-9158`).
  let national = digits;
  if (digits.length > 11) {
    if (!digits.startsWith(BRAZIL_DDI)) return null;
    national = digits.slice(BRAZIL_DDI.length);
  }

  if (national.length !== 10 && national.length !== 11) return null;

  const ddd = national.slice(0, 2);
  if (!VALID_BRAZILIAN_DDDS.has(ddd)) return null;

  let subscriber = national.slice(2);
  // Celular anterior ao nono dígito (8 dígitos começando em 6-9): completa.
  // Fixo (2-5) fica com 8 dígitos — 12 no total, sem o nono dígito.
  if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
    subscriber = `9${subscriber}`;
  }
  // 9 dígitos significa celular: no Brasil todo número com 11 dígitos (DDD +
  // 9 dígitos) começa em `9`. Qualquer outra combinação não existe e a
  // Evolution recusaria o envio.
  if (subscriber.length === 9 && !subscriber.startsWith("9")) return null;

  return `${BRAZIL_DDI}${ddd}${subscriber}`;
}

/**
 * Mesmo resultado de `normalizeWhatsAppNumber`, mas SOMENTE para celular
 * (9 dígitos após o DDD começando em `9`).
 *
 * É a validação correta antes de enviar pelo WhatsApp: fixo e números fora do
 * padrão de celular não são entregáveis e a Evolution responde
 * `400 Bad Request` — nesse caso o chamador deve ignorar o envio.
 */
export function normalizeWhatsAppMobileNumber(
  raw: string | null | undefined
): string | null {
  const normalized = normalizeWhatsAppNumber(raw);
  if (!normalized) return null;
  const national = normalized.slice(BRAZIL_DDI.length);
  return isMobileNationalNumber(national) ? normalized : null;
}

/** `true` quando o número (com ou sem máscara) é um celular brasileiro válido. */
export function isWhatsAppMobileNumber(
  raw: string | null | undefined
): boolean {
  return normalizeWhatsAppMobileNumber(raw) !== null;
}

/** Telefone formatado para exibição na mensagem (`(17) 99265-0460`). */
export function formatWhatsAppPhoneForDisplay(
  raw: string | null | undefined
): string | null {
  const normalized = normalizeWhatsAppNumber(raw);
  if (!normalized) return null;

  const national = normalized.slice(BRAZIL_DDI.length);
  if (national.length === 11) {
    return `(${national.slice(0, 2)}) ${national.slice(2, 7)}-${national.slice(7)}`;
  }
  if (national.length === 10) {
    return `(${national.slice(0, 2)}) ${national.slice(2, 6)}-${national.slice(6)}`;
  }
  return normalized;
}
