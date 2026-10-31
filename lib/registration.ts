/**
 * Contrato compartilhado do cadastro de estabelecimentos (Ipepper).
 *
 * Módulo **isomórfico** (sem APIs de navegador/servidor): as mesmas regras,
 * máscaras e limites são usados
 *  - pelo formulário público `/cadastro` (Client Component),
 *  - pela etapa de onboarding pós-OAuth `/completar-cadastro` (Client Component),
 *  - pela rota `POST /api/signup` (e-mail + senha) e
 *  - pela rota `POST /api/signup/establishment` (Google/OAuth).
 *
 * Assim o cliente valida antes de enviar e o servidor revalida com exatamente
 * o mesmo código — sem mensagens divergentes.
 */

import { isValidCpfCnpj } from "./billing";
import { slugify } from "./slug";

// ---------------------------------------------------------------------------
// Documento (CPF / CNPJ)
// ---------------------------------------------------------------------------

/** Tipos de documento aceitos no cadastro (`establishments.document_type`). */
export const DOCUMENT_TYPES = ["cpf", "cnpj"] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Rótulos exibidos no toggle CPF/CNPJ. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  cpf: "CPF",
  cnpj: "CNPJ",
};

/** Placeholder de cada documento (mesmo formato salvo pela máscara). */
export const DOCUMENT_PLACEHOLDERS: Record<DocumentType, string> = {
  cpf: "000.000.000-00",
  cnpj: "00.000.000/0001-00",
};

/** Quantidade de dígitos de cada documento (sem máscara). */
export const DOCUMENT_DIGITS: Record<DocumentType, number> = {
  cpf: 11,
  cnpj: 14,
};

/** Type guard para valores vindos do cliente/banco. */
export function isDocumentType(value: unknown): value is DocumentType {
  return (
    typeof value === "string" &&
    (DOCUMENT_TYPES as readonly string[]).includes(value)
  );
}

/** Remove tudo que não for dígito (documento, WhatsApp…). */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Máscara progressiva do documento conforme o tipo escolhido:
 *  - CPF  → `000.000.000-00`
 *  - CNPJ → `00.000.000/0001-00`
 *
 * O valor é truncado no tamanho máximo do tipo (evita colar um CNPJ no CPF).
 */
export function formatDocumentInput(
  value: string,
  type: DocumentType
): string {
  const digits = onlyDigits(value).slice(0, DOCUMENT_DIGITS[type]);

  if (type === "cpf") {
    return digits
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2");
  }

  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

/**
 * Máscara progressiva do WhatsApp: `(00) 0000-0000` ou `(00) 00000-0000`.
 * O valor salvo no banco é sempre só dígitos (`onlyDigits`).
 */
export function formatWhatsappInput(value: string): string {
  const digits = onlyDigits(value).slice(0, 11);

  if (digits.length <= 10) {
    return digits
      .replace(/^(\d{2})(\d)/, "($1) $2")
      .replace(/(\d{4})(\d)/, "$1-$2");
  }

  return digits
    .replace(/^(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d)/, "$1-$2");
}

// ---------------------------------------------------------------------------
// Limites e padrões
// ---------------------------------------------------------------------------

/** Nome do responsável / do estabelecimento. */
export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 80;

/** O Supabase Auth aceita no mínimo 6 caracteres (e no máximo 72 caracteres). */
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 72;

/** Slug público do cardápio (rota `/[slug]`). */
export const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 60;

/** Prefixo fixo exibido ao lado do campo de link do cardápio. */
export const SLUG_PREFIX = "ipepper.com.br/";

/** Formato aceito no banco/URL: minúsculas, números e hífens simples. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validação mínima de e-mail (mesmo padrão usado no login e no checkout). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Rotas fixas da aplicação — não podem virar slug de cardápio.
 * Usado tanto no cliente (aviso imediato) quanto no servidor (fonte da verdade).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "auth",
  "cadastro",
  "cardapio",
  "checkout",
  "clientes",
  "completar-cadastro",
  "configuracoes",
  "confirmar-email",
  "cupons",
  "demo",
  "login",
  "nova-senha",
  "painel",
  "pedido",
  "pedidos",
  "produtos",
  "relatorios",
]);

// ---------------------------------------------------------------------------
// Validações (mensagens únicas para cliente e servidor)
// ---------------------------------------------------------------------------

/** Devolve a mensagem de erro do nome do responsável, ou `null` se válido. */
export function ownerNameError(value: string): string | null {
  const name = value.trim();

  if (name.length < MIN_NAME_LENGTH) return "Informe o nome do responsável.";
  if (name.length > MAX_NAME_LENGTH) {
    return `O nome do responsável deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`;
  }
  return null;
}

/** Devolve a mensagem de erro do e-mail, ou `null` se válido. */
export function emailError(value: string): string | null {
  return EMAIL_PATTERN.test(value.trim()) ? null : "Informe um e-mail válido.";
}

/** Devolve a mensagem de erro da senha, ou `null` se válida. */
export function passwordError(value: string): string | null {
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use ao menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `A senha deve ter no máximo ${MAX_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

/**
 * Campos da etapa "dados do estabelecimento".
 *
 * Os nomes espelham as colunas de `public.establishments` (`name`,
 * `document_type`, `document_number`, `whatsapp`, `slug`) para que o payload
 * das rotas seja o mesmo do formulário.
 */
export type EstablishmentField =
  | "name"
  | "document_type"
  | "document_number"
  | "whatsapp"
  | "slug";

/** Dados do estabelecimento preenchidos no cadastro. */
export interface EstablishmentDraft {
  /** Nome do estabelecimento (`establishments.name`). */
  name: string;
  document_type: DocumentType;
  /** Documento com ou sem máscara (o servidor salva só dígitos). */
  document_number: string;
  /** WhatsApp com ou sem máscara (o servidor salva só dígitos). */
  whatsapp: string;
  /** Link do cardápio sem o prefixo `ipepper.com.br/`. */
  slug: string;
}

/** Erros por campo da etapa do estabelecimento. */
export type EstablishmentErrors = Partial<Record<EstablishmentField, string>>;

/** Valida um documento conforme o tipo escolhido (tamanho + dígitos). */
function documentError(number: string, type: DocumentType): string | null {
  const digits = onlyDigits(number);

  if (digits.length === 0) {
    return `Informe o ${DOCUMENT_TYPE_LABELS[type]} do estabelecimento.`;
  }

  if (digits.length !== DOCUMENT_DIGITS[type]) {
    return `O ${DOCUMENT_TYPE_LABELS[type]} deve ter ${DOCUMENT_DIGITS[type]} dígitos.`;
  }

  if (!isValidCpfCnpj(digits)) {
    return `${DOCUMENT_TYPE_LABELS[type]} inválido. Confira os números.`;
  }

  return null;
}

/**
 * Valida a etapa do estabelecimento e devolve os erros por campo
 * (objeto vazio = tudo válido).
 *
 * Regras (idênticas no cliente e no servidor):
 *  - nome com 2 a 80 caracteres;
 *  - documento com o tamanho do tipo escolhido e dígitos verificadores;
 *  - WhatsApp com DDD (10 ou 11 dígitos);
 *  - slug com 3 a 60 caracteres, formato URL-safe e fora das rotas reservadas.
 */
export function validateEstablishmentDraft(
  draft: EstablishmentDraft
): EstablishmentErrors {
  const errors: EstablishmentErrors = {};

  const name = draft.name.trim();
  if (name.length < MIN_NAME_LENGTH) {
    errors.name = "Informe o nome do estabelecimento.";
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`;
  }

  const validType =
    draft.document_type === "cpf" || draft.document_type === "cnpj";

  if (!validType) {
    errors.document_type = "Escolha CPF ou CNPJ.";
  } else {
    const documentMessage = documentError(
      draft.document_number,
      draft.document_type
    );
    if (documentMessage) errors.document_number = documentMessage;
  }

  const whatsappDigits = onlyDigits(draft.whatsapp);
  if (whatsappDigits.length < 10 || whatsappDigits.length > 11) {
    errors.whatsapp = "Informe o WhatsApp com DDD (10 ou 11 dígitos).";
  }

  const slug = slugify(draft.slug || draft.name);
  if (slug.length < MIN_SLUG_LENGTH) {
    errors.slug = "Escolha um link com ao menos 3 caracteres.";
  } else if (slug.length > MAX_SLUG_LENGTH) {
    errors.slug = `O link deve ter no máximo ${MAX_SLUG_LENGTH} caracteres.`;
  } else if (!SLUG_PATTERN.test(slug)) {
    errors.slug = "Use apenas letras minúsculas, números e hífens.";
  } else if (RESERVED_SLUGS.has(slug)) {
    errors.slug = `O link "${slug}" é reservado pela plataforma. Escolha outro.`;
  }

  return errors;
}

/** Resultado normalizado de um formulário de estabelecimento. */
export interface NormalizedEstablishmentDraft {
  name: string;
  documentType: DocumentType;
  /** Documento só com dígitos (formato salvo em `document_number`). */
  documentNumber: string;
  /** WhatsApp só com dígitos (salvo em `phone` e `whatsapp`). */
  whatsapp: string;
  /** Slug final já normalizado (sem o prefixo `ipepper.com.br/`). */
  slug: string;
}

/**
 * Normaliza o rascunho para persistência: remove máscaras, gera o slug a partir
 * do nome quando o campo está vazio e limita o tamanho.
 *
 * Deve ser chamado **depois** de `validateEstablishmentDraft`.
 */
export function normalizeEstablishmentDraft(
  draft: EstablishmentDraft
): NormalizedEstablishmentDraft {
  return {
    name: draft.name.trim(),
    documentType: draft.document_type === "cnpj" ? "cnpj" : "cpf",
    documentNumber: onlyDigits(draft.document_number),
    whatsapp: onlyDigits(draft.whatsapp),
    slug: slugify(draft.slug || draft.name).slice(0, MAX_SLUG_LENGTH),
  };
}

/**
 * Nome do responsável a partir dos metadados do Supabase Auth.
 *
 * O Google entrega `full_name`/`name`; contas criadas por e-mail usam
 * `owner_name` (definido em `/api/signup`). Sem metadados, deriva do e-mail.
 */
export function resolveOwnerName(
  metadata: Record<string, unknown> | null | undefined,
  email: string | null | undefined
): string {
  const candidates = ["owner_name", "full_name", "name", "display_name"] as const;

  for (const key of candidates) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, MAX_NAME_LENGTH);
    }
  }

  const local = (email ?? "").split("@")[0] ?? "";
  const words = local.replace(/[._-]+/g, " ").trim();

  if (!words) return "";

  return words
    .replace(/\s+/g, " ")
    .replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase())
    .slice(0, MAX_NAME_LENGTH);
}
