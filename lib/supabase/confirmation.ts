import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reenvio do e-mail de confirmação de cadastro (GoTrue).
 *
 * Módulo **isomórfico**: contém apenas constantes e funções puras, por isso pode
 * ser importado tanto por Route Handlers (`/api/signup`,
 * `/api/auth/resend-confirmation`) quanto por Client Components
 * (`ConfirmEmailPanel`), que reaproveitam as mensagens e o cooldown.
 *
 * A chave de serviço NUNCA entra aqui: quem chama passa o client administrativo
 * já criado (`createAdminClient`), mantendo este arquivo livre de segredos.
 *
 * Ver `docs/confirmacao-email.md`.
 */

/**
 * Intervalo mínimo entre dois pedidos de reenvio para o MESMO e-mail.
 *
 * Serve para dois fins: espelha o limite do GoTrue (`over_email_send_rate_limit`,
 * que responde 429) e evita que a tela dispare vários pedidos em sequência —
 * o SMTP padrão do Supabase tem uma cota baixa de e-mails por hora.
 */
export const CONFIRMATION_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Mensagem única para o rate limit (HTTP 429).
 *
 * O servidor responde com este texto e a tela o reaproveita: assim o usuário
 * nunca vê duas versões diferentes do mesmo aviso.
 */
export const CONFIRMATION_RATE_LIMIT_MESSAGE =
  "Aguarde 1 minuto antes de solicitar um novo e-mail";

/** Destino do link de confirmação (o callback troca o token e abre o painel). */
export const CONFIRMATION_REDIRECT_PATH = "/painel";

/**
 * Monta o `emailRedirectTo` do link de confirmação:
 * `${origin}/auth/callback?next=/painel`.
 *
 * O formato `?next=` é o que `app/auth/callback/route.ts` entende; o template do
 * e-mail no Supabase deve apontar para o mesmo caminho com `token_hash` (ver
 * `docs/confirmacao-email.md`).
 */
export function buildEmailConfirmationRedirect(
  origin: string,
  next: string = CONFIRMATION_REDIRECT_PATH
): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/auth/callback?next=${encodeURIComponent(next)}`;
}

/**
 * Origem pública da requisição (`http://localhost:3000`, `https://app...`).
 *
 * Em produção o `request.url` já traz o domínio correto (inclusive atrás do
 * proxy da Vercel). Retorna `null` quando a URL não é absoluta, para o chamador
 * cair em `getAppUrl()` (`NEXT_PUBLIC_APP_URL`).
 */
export function getRequestOrigin(request: Request): string | null {
  try {
    const origin = new URL(request.url).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Lê os segundos restantes da mensagem do GoTrue.
 *
 * O texto é `For security purposes, you can only request this after 42
 * seconds.` — usamos o número para informar ao usuário exatamente quanto falta,
 * em vez de um "tente mais tarde" genérico.
 */
export function parseRetryAfterSeconds(message?: string | null): number | null {
  if (!message) return null;

  const match = /after (\d+) seconds?/i.exec(message);
  if (!match) return null;

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  return Math.ceil(seconds);
}

/** Códigos normalizados devolvidos por `resendSignupConfirmation`. */
export type ConfirmationResendErrorCode =
  | "rate_limited"
  | "already_confirmed"
  | "user_not_found"
  | "email_disabled"
  | "send_failed";

/** Resultado do reenvio já traduzido: a rota só mapeia para o HTTP correto. */
export type ConfirmationResendResult =
  | { ok: true }
  | {
      ok: false;
      code: ConfirmationResendErrorCode;
      message: string;
      /** Segundos até poder tentar de novo (apenas em `rate_limited`). */
      retryAfterSeconds: number | null;
    };

/**
 * Reenvia o e-mail de confirmação de `signup` usando a service role.
 *
 * Por que no servidor: o `supabase.auth.resend` do navegador esbarra em CORS,
 * em bloqueadores de terceiros e no rate limit do Supabase — sem contar que o
 * erro do GoTrue chega cru (`status`/`code`), o que deixava a tela sem mensagem.
 * Aqui o erro é classificado e devolvido pronto para a interface.
 *
 * Também é a mesma função usada por `/api/signup` logo após criar a conta
 * pendente (o `admin.createUser` não dispara e-mail).
 */
export async function resendSignupConfirmation(
  client: SupabaseClient,
  params: { email: string; emailRedirectTo: string }
): Promise<ConfirmationResendResult> {
  const { error } = await client.auth.resend({
    type: "signup",
    email: params.email,
    options: { emailRedirectTo: params.emailRedirectTo },
  });

  if (!error) return { ok: true };

  const code = String(
    (error as { code?: string | null }).code ?? ""
  ).toLowerCase();
  const message = error.message ?? "";
  const retryAfterSeconds = parseRetryAfterSeconds(message);

  // Rate limit do GoTrue: status 429 ou o texto "after N seconds".
  if (
    error.status === 429 ||
    code === "over_email_send_rate_limit" ||
    retryAfterSeconds !== null
  ) {
    return {
      ok: false,
      code: "rate_limited",
      message: CONFIRMATION_RATE_LIMIT_MESSAGE,
      retryAfterSeconds:
        retryAfterSeconds ?? CONFIRMATION_RESEND_COOLDOWN_SECONDS,
    };
  }

  if (
    code === "email_already_confirmed" ||
    /already (been )?confirmed/i.test(message)
  ) {
    return {
      ok: false,
      code: "already_confirmed",
      message:
        "Este e-mail já está confirmado. Faça login para acessar o painel.",
      retryAfterSeconds: null,
    };
  }

  if (
    code === "user_not_found" ||
    error.status === 404 ||
    /user not found/i.test(message)
  ) {
    return {
      ok: false,
      code: "user_not_found",
      message:
        "Não encontramos uma conta com este e-mail. Confira o endereço digitado ou crie uma conta.",
      retryAfterSeconds: null,
    };
  }

  // Projeto sem envio de e-mail habilitado (SMTP/provider desligado): o aviso
  // precisa ser explícito, porque nenhuma tentativa do usuário vai funcionar.
  if (
    code === "email_provider_disabled" ||
    code === "email_provider_disabled_signup" ||
    /email (provider|signups?) (is )?disabled/i.test(message) ||
    /signups? not allowed/i.test(message)
  ) {
    return {
      ok: false,
      code: "email_disabled",
      message:
        "O envio de e-mails de confirmação está desativado no projeto Supabase. Fale com o suporte.",
      retryAfterSeconds: null,
    };
  }

  return {
    ok: false,
    code: "send_failed",
    message:
      "Não foi possível enviar o e-mail de confirmação agora. Tente novamente em alguns minutos.",
    retryAfterSeconds: null,
  };
}
