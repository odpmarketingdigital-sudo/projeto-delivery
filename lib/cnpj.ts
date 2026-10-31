/**
 * Consulta de CNPJ na BrasilAPI (dados da Receita Federal).
 *
 * Usado pelo cadastro público (`/cadastro`) para avisar quando a empresa não
 * está apta (situação cadastral diferente de `ATIVA`). A BrasilAPI é pública,
 * não exige chave e responde com CORS liberado, então a chamada acontece
 * direto do navegador — sem rota intermediária e sem expor credenciais.
 *
 * Regras do módulo:
 *  - o número é validado (tamanho + dígitos verificadores) antes de qualquer
 *    requisição, evitando chamadas inúteis para números impossíveis;
 *  - a resposta fica em cache de memória por alguns minutos, pois a situação
 *    cadastral muda raramente e o mesmo CNPJ não deve ser consultado duas
 *    vezes na mesma sessão;
 *  - qualquer falha externa vira `{ ok: false, reason: "unavailable" }`: a
 *    BrasilAPI é um serviço de terceiros e nunca deve derrubar o cadastro.
 *
 * Endpoint: https://brasilapi.com.br/api/cnpj/v1/{cnpj} (somente dígitos).
 */

import { isValidCpfCnpj, onlyDigits } from "./billing";

/** Base da consulta pública de CNPJ. */
export const CNPJ_API_BASE = "https://brasilapi.com.br/api/cnpj/v1";

/** Situação cadastral que permite concluir o cadastro. */
export const CNPJ_SITUACAO_ATIVA = "ATIVA";

/** Tempo máximo de espera pela BrasilAPI antes de desistir da consulta. */
export const CNPJ_LOOKUP_TIMEOUT_MS = 7000;

/** Quantidade de dígitos de um CNPJ (sem máscara). */
const CNPJ_DIGITS_LENGTH = 14;

/** Validade do cache em memória (situação cadastral muda raramente). */
const CNPJ_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Códigos de situação cadastral da Receita → descrição.
 *
 * A BrasilAPI devolve `situacao_cadastral` como número e a descrição pronta em
 * `descricao_situacao_cadastral`. O mapa é o fallback quando só o código vier.
 */
const SITUACAO_BY_CODE: Record<number, string> = {
  1: "NULA",
  2: CNPJ_SITUACAO_ATIVA,
  3: "SUSPENSA",
  4: "INAPTA",
  8: "BAIXADA",
};

/** Dados da empresa devolvidos pela consulta (apenas o que o cadastro usa). */
export interface CnpjInfo {
  /** CNPJ só com dígitos (14). */
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  municipio: string | null;
  uf: string | null;
  /**
   * Situação normalizada em caixa alta (ex.: `"ATIVA"`, `"BAIXADA"`).
   * `null` quando a API responde em um formato não reconhecido.
   */
  situacao: string | null;
}

/** Motivos de falha da consulta. */
export type CnpjLookupFailure = "invalid" | "not_found" | "unavailable";

/** Resultado discriminado da consulta. */
export type CnpjLookupResult =
  | { ok: true; info: CnpjInfo }
  | { ok: false; reason: CnpjLookupFailure };

const cnpjCache = new Map<string, { info: CnpjInfo; expiresAt: number }>();

function readCache(cnpj: string): CnpjInfo | null {
  const entry = cnpjCache.get(cnpj);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cnpjCache.delete(cnpj);
    return null;
  }
  return entry.info;
}

function writeCache(info: CnpjInfo): void {
  cnpjCache.set(info.cnpj, {
    info,
    expiresAt: Date.now() + CNPJ_CACHE_TTL_MS,
  });
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Valida um CNPJ (14 dígitos + dígitos verificadores). Aceita máscara.
 *
 * Reaproveita a mesma implementação usada no faturamento (`lib/billing.ts`),
 * para que cadastro e assinatura nunca discordem sobre um documento.
 */
export function isValidCnpj(value: string): boolean {
  const digits = onlyDigits(value);
  return digits.length === CNPJ_DIGITS_LENGTH && isValidCpfCnpj(digits);
}

/** `true` apenas quando a situação é exatamente `ATIVA`. */
export function isCnpjSituacaoAtiva(situacao: string | null): boolean {
  return situacao === CNPJ_SITUACAO_ATIVA;
}

/**
 * Extrai a situação cadastral da resposta da BrasilAPI.
 *
 * Prioridade: `descricao_situacao_cadastral` (texto pronto) → código numérico
 * em `situacao_cadastral` → texto em `situacao_cadastral` (formatos antigos).
 */
function readSituacao(payload: Record<string, unknown>): string | null {
  const description = clean(payload.descricao_situacao_cadastral);
  if (description) return description.toUpperCase();

  const raw = payload.situacao_cadastral;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return SITUACAO_BY_CODE[raw] ?? null;
  }

  const text = clean(raw);
  if (!text) return null;
  if (/^\d+$/.test(text)) return SITUACAO_BY_CODE[Number(text)] ?? null;
  return text.toUpperCase();
}

/** Normaliza o JSON da BrasilAPI no contrato `CnpjInfo`. */
function toCnpjInfo(cnpj: string, payload: unknown): CnpjInfo | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;

  return {
    cnpj,
    razaoSocial: clean(record.razao_social),
    nomeFantasia: clean(record.nome_fantasia),
    municipio: clean(record.municipio),
    uf: clean(record.uf),
    situacao: readSituacao(record),
  };
}

/**
 * `fetch` com timeout próprio + cancelamento externo (troca do CNPJ digitado).
 * Devolve `null` em qualquer erro de rede/abort — o chamador só precisa saber
 * que a consulta não foi concluída.
 */
async function requestCnpj(
  cnpj: string,
  signal?: AbortSignal
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CNPJ_LOOKUP_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();

  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await fetch(`${CNPJ_API_BASE}/${cnpj}`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Consulta a situação cadastral de um CNPJ na BrasilAPI.
 *
 * - `invalid`     → número não passa nos dígitos verificadores (nada é enviado);
 * - `not_found`   → a Receita não tem esse CNPJ (HTTP 404);
 * - `unavailable` → erro de rede, timeout, abort ou resposta fora do formato.
 */
export async function lookupCnpj(
  value: string,
  options: { signal?: AbortSignal } = {}
): Promise<CnpjLookupResult> {
  const cnpj = onlyDigits(value);

  if (!isValidCnpj(cnpj)) return { ok: false, reason: "invalid" };
  if (options.signal?.aborted) return { ok: false, reason: "unavailable" };

  const cached = readCache(cnpj);
  if (cached) return { ok: true, info: cached };

  const response = await requestCnpj(cnpj, options.signal);
  if (!response) return { ok: false, reason: "unavailable" };
  if (response.status === 404) return { ok: false, reason: "not_found" };
  if (!response.ok) return { ok: false, reason: "unavailable" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  const info = toCnpjInfo(cnpj, payload);
  if (!info) return { ok: false, reason: "unavailable" };

  // Só memoriza respostas com situação reconhecida: se a API mudar o formato,
  // preferimos consultar de novo a repetir um resultado incompleto.
  if (info.situacao) writeCache(info);

  return { ok: true, info };
}
