/**
 * Envio do e-mail de boas-vindas (Resend).
 *
 * Camada entre o cadastro (`/api/signup`) e o template:
 *  1. monta as props do template com os dados do estabelecimento recém-criado
 *     (nome da loja, dono, slug, fim do trial e atalhos do painel);
 *  2. renderiza o HTML/texto com `renderWelcomeEmail`;
 *  3. dispara o envio pelo Resend.
 *
 * Server-side apenas: usa `react-dom/server` (via template) e a service key do
 * provedor. Nenhum Client Component deve importar este módulo.
 */

import {
  getAppUrl,
  getEmailFrom,
  getEmailLogoUrl,
  getEmailReplyTo,
} from "@/lib/email/config";
import { getResendClient } from "@/lib/email/resend";
import {
  renderWelcomeEmail,
  type RenderedEmail,
  type WelcomeEmailProps,
} from "@/lib/email/templates/welcome";
import { TRIAL_DAYS } from "@/lib/subscriptions";

/** Mesmo padrão de validação usado em `/api/signup`. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Dados do cadastro necessários para montar o e-mail. */
export interface WelcomeEmailInput {
  /** Destinatário (e-mail do responsável pela loja). */
  to: string;
  /** Nome do responsável — aparece no "Olá" e no assunto. */
  ownerName: string;
  /** Nome do estabelecimento recém-criado. */
  establishmentName: string;
  /** Slug do cardápio público; `null`/vazio quando ainda não existe. */
  slug?: string | null;
  /** Fim do trial em ISO 8601 (`establishments.trial_ends_at`). */
  trialEndsAt?: string | null;
  /** Duração do trial em dias (padrão `TRIAL_DAYS`). */
  trialDays?: number;
  /** Data de referência — injetável nos testes. */
  now?: Date;
}

/**
 * Resultado do envio.
 *
 * Nunca lança: o cadastro continua válido mesmo se o provedor falhar (a conta
 * já foi criada e o usuário consegue entrar no painel).
 */
export type WelcomeEmailResult =
  | { status: "sent"; id: string | null }
  | { status: "skipped"; reason: "not-configured" | "invalid-recipient" }
  | { status: "failed"; error: string };

/**
 * Formata o fim do trial como `10 de dezembro de 2026`.
 *
 * Usa o fuso de Brasília (mesmo critério de `lib/subscriptions.ts`) para não
 * exibir um dia a menos em horários próximos da meia-noite.
 */
export function formatTrialEndsAtLabel(
  trialEndsAt: string | null | undefined
): string | null {
  if (!trialEndsAt) return null;

  const date = new Date(trialEndsAt);
  if (!Number.isFinite(date.getTime())) return null;

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** Monta as props do template a partir dos dados do cadastro. */
export function buildWelcomeEmailProps(
  input: WelcomeEmailInput
): WelcomeEmailProps {
  const appUrl = getAppUrl();
  const slug = input.slug?.trim() || null;

  return {
    ownerName: input.ownerName,
    establishmentName: input.establishmentName,
    panelUrl: `${appUrl}/painel`,
    menuUrl: slug ? `${appUrl}/${slug}` : null,
    logoUrl: getEmailLogoUrl(),
    trialDays: input.trialDays ?? TRIAL_DAYS,
    trialEndsAtLabel: formatTrialEndsAtLabel(input.trialEndsAt),
    productsUrl: `${appUrl}/painel/produtos`,
    settingsUrl: `${appUrl}/painel/configuracoes`,
    subscriptionUrl: `${appUrl}/painel/assinatura`,
    supportEmail: getEmailReplyTo(),
    appUrl,
    year: (input.now ?? new Date()).getFullYear(),
  };
}

/** Renderiza assunto/HTML/texto sem enviar (útil para preview e testes). */
export async function renderWelcomeEmailFor(
  input: WelcomeEmailInput
): Promise<RenderedEmail> {
  return renderWelcomeEmail(buildWelcomeEmailProps(input));
}

/**
 * Envia o e-mail de boas-vindas.
 *
 * Sem `RESEND_API_KEY` (ou com destinatário inválido) retorna `skipped`, para
 * que o chamador apenas registre um aviso em vez de quebrar o cadastro.
 */
export async function sendWelcomeEmail(
  input: WelcomeEmailInput
): Promise<WelcomeEmailResult> {
  const to = input.to?.trim() ?? "";

  if (!EMAIL_PATTERN.test(to)) {
    return { status: "skipped", reason: "invalid-recipient" };
  }

  const resend = getResendClient();
  if (!resend) {
    return { status: "skipped", reason: "not-configured" };
  }

  const email = await renderWelcomeEmailFor({ ...input, to });
  const replyTo = getEmailReplyTo();

  try {
    const { data, error } = await resend.emails.send({
      from: getEmailFrom(),
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(replyTo ? { replyTo } : {}),
    });

    if (error) {
      return { status: "failed", error: error.message };
    }

    return { status: "sent", id: data?.id ?? null };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Erro desconhecido no envio.";

    return { status: "failed", error: message };
  }
}

/**
 * Versão "best effort" usada pelo cadastro: registra o resultado no console e
 * nunca propaga erro, porque a loja já foi criada e o usuário já pode acessar.
 */
export async function sendWelcomeEmailSafely(
  input: WelcomeEmailInput
): Promise<WelcomeEmailResult> {
  const result = await sendWelcomeEmail(input);

  if (result.status === "failed") {
    console.warn(
      `[email/boas-vindas] falha ao enviar para ${input.to}: ${result.error}`
    );
  } else if (result.status === "skipped" && result.reason === "not-configured") {
    console.warn(
      "[email/boas-vindas] RESEND_API_KEY ausente — e-mail de boas-vindas não enviado."
    );
  }

  return result;
}
