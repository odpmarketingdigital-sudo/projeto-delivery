/**
 * Rascunho do estabelecimento preenchido em `/cadastro` antes da autenticação.
 *
 * O fluxo de cadastro ficou em duas etapas: primeiro os dados da loja (nome,
 * documento, WhatsApp e link do cardápio), depois a criação do acesso (Google ou
 * e-mail + senha). No caminho do Google o usuário **sai da página** e volta pelo
 * `/auth/callback`, então o rascunho precisa sobreviver ao redirect:
 *
 *  - `sessionStorage` (`SIGNUP_DRAFT_STORAGE_KEY`) → fonte do navegador: mesma
 *    aba, some ao fechar/encerrar a sessão;
 *  - cookie curto (`SIGNUP_DRAFT_COOKIE`, 30 min, `SameSite=Lax`) → transporte
 *    até o servidor. `/auth/callback` é uma Route Handler (server) e **não** tem
 *    acesso ao `sessionStorage`; é esse cookie que permite criar a loja já
 *    vinculada ao `user_id` recém-criado pelo Google, sem obrigar o usuário a
 *    digitar tudo outra vez.
 *
 * O cookie só carrega dados que o próprio usuário digitou naquele navegador e é
 * apagado (Max-Age=0) assim que o callback conclui o cadastro.
 *
 * Módulo isomórfico — mesmo padrão de `lib/whatsappOrder.ts`: os helpers de
 * navegador checam `typeof window` antes de tocar em APIs do DOM.
 */

import {
  isDocumentType,
  normalizeEstablishmentDraft,
  type EstablishmentDraft,
} from "./registration";

/** Chave do `sessionStorage` (convenção `ipepper:` do restante do app). */
export const SIGNUP_DRAFT_STORAGE_KEY = "ipepper:signup_establishment_draft";

/** Cookie que leva o rascunho até `app/auth/callback/route.ts`. */
export const SIGNUP_DRAFT_COOKIE = "ipepper_signup_draft";

/** Validade do rascunho: 30 minutos (folga suficiente para o OAuth do Google). */
export const SIGNUP_DRAFT_MAX_AGE_SECONDS = 30 * 60;

/** Rascunho já normalizado (documento/WhatsApp só com dígitos, slug pronto). */
export type SignupDraft = EstablishmentDraft;

/**
 * Normaliza o rascunho para o formato persistido.
 *
 * Delega para `normalizeEstablishmentDraft` (mesma normalização usada por
 * `POST /api/signup` e `/completar-cadastro`): documento e WhatsApp só com
 * dígitos, slug derivado do nome quando o campo está vazio e limitado a
 * `MAX_SLUG_LENGTH`.
 */
export function normalizeSignupDraft(draft: EstablishmentDraft): SignupDraft {
  const normalized = normalizeEstablishmentDraft(draft);

  return {
    name: normalized.name,
    document_type: normalized.documentType,
    document_number: normalized.documentNumber,
    whatsapp: normalized.whatsapp,
    slug: normalized.slug,
  };
}

// ---------------------------------------------------------------------------
// Codificação (base64url — caracteres seguros para cookie/URL)
// ---------------------------------------------------------------------------

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(token: string): string | null {
  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Leitura tolerante (o valor vem de cookie: pode chegar truncado/adulterado)
// ---------------------------------------------------------------------------

function readDraft(value: unknown): SignupDraft | null {
  if (!value || typeof value !== "object") return null;

  const data = value as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name.trim() : "";

  if (!name) return null;
  if (!isDocumentType(data.document_type)) return null;

  return normalizeSignupDraft({
    name,
    document_type: data.document_type,
    document_number:
      typeof data.document_number === "string" ? data.document_number : "",
    whatsapp: typeof data.whatsapp === "string" ? data.whatsapp : "",
    slug: typeof data.slug === "string" ? data.slug : "",
  });
}

/**
 * Serializa o rascunho para o valor do cookie (base64url do JSON normalizado).
 *
 * O `/auth/callback` nunca usa os campos crus: `decodeSignupDraftCookie`
 * revalida tudo antes de gravar a loja.
 */
export function encodeSignupDraftCookie(draft: EstablishmentDraft): string {
  return toBase64Url(JSON.stringify(normalizeSignupDraft(draft)));
}

/**
 * Recupera o rascunho do valor do cookie (ou `null` se inválido).
 *
 * Cookie truncado, adulterado ou de outra origem cai em `null`: o usuário segue
 * para o onboarding (`/completar-cadastro`) em vez de criar uma loja inválida.
 */
export function decodeSignupDraftCookie(
  value: string | null | undefined
): SignupDraft | null {
  if (!value) return null;

  const json = fromBase64Url(value);
  if (!json) return null;

  try {
    return readDraft(JSON.parse(json));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers de navegador
// ---------------------------------------------------------------------------

/**
 * Recupera o rascunho do `sessionStorage`.
 *
 * Usado por `/cadastro` para repovoar a etapa da loja quando o usuário volta do
 * Google com erro (a página recarrega e o estado do formulário se perde) ou
 * reabre a tela na mesma aba.
 */
export function readSignupDraft(): SignupDraft | null {
  if (typeof window === "undefined") return null;

  let raw: string | null = null;

  try {
    raw = window.sessionStorage.getItem(SIGNUP_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!raw) return null;

  try {
    return readDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeDraftCookie(value: string): void {
  // `Secure` só em HTTPS: em `http://localhost` o cookie seria descartado.
  const secure = window.location.protocol === "https:" ? "; Secure" : "";

  document.cookie =
    `${SIGNUP_DRAFT_COOKIE}=${value}; Path=/; ` +
    `Max-Age=${SIGNUP_DRAFT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

/**
 * Guarda os dados da loja antes do redirect para o Google.
 *
 * Chamado por `/cadastro` no clique de "Continuar com Google": sem isso o
 * `/auth/callback` não teria como criar o estabelecimento do usuário novo.
 * Devolve o rascunho normalizado (mesmo formato lido pelo servidor).
 */
export function saveSignupDraft(draft: EstablishmentDraft): SignupDraft {
  const normalized = normalizeSignupDraft(draft);

  if (typeof window === "undefined") return normalized;

  try {
    window.sessionStorage.setItem(
      SIGNUP_DRAFT_STORAGE_KEY,
      JSON.stringify(normalized)
    );
  } catch {
    /* armazenamento indisponível — o cookie ainda transporta o rascunho */
  }

  writeDraftCookie(encodeSignupDraftCookie(normalized));

  return normalized;
}

/**
 * O cookie do rascunho está realmente gravado neste navegador?
 *
 * Checagem final antes de sair para o Google: `document.cookie` é síncrono,
 * mas o navegador pode **recusar** a gravação (cookies bloqueados, modo
 * privado restritivo, política corporativa). Nesse caso o `/auth/callback`
 * nunca receberia o rascunho e a conta terminaria sem estabelecimento — o
 * `/cadastro` usa esta função para abortar o redirect e avisar o usuário.
 */
export function hasSignupDraftCookie(): boolean {
  if (typeof window === "undefined") return false;

  return document.cookie
    .split(";")
    .some((entry) => entry.trim().startsWith(`${SIGNUP_DRAFT_COOKIE}=`));
}

/**
 * Descarta o rascunho (cadastro concluído ou abandonado).
 *
 * No caminho do Google a limpeza do cookie acontece na resposta de redirect da
 * `/auth/callback`; aqui as duas cópias do navegador saem juntas.
 */
export function clearSignupDraft(): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(SIGNUP_DRAFT_STORAGE_KEY);
  } catch {
    /* armazenamento indisponível */
  }

  // Mesmos atributos da escrita: no Chrome um cookie `Secure` só é sobrescrito
  // (inclusive para apagar) por outro com o mesmo atributo.
  const secure = window.location.protocol === "https:" ? "; Secure" : "";

  document.cookie = `${SIGNUP_DRAFT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}
