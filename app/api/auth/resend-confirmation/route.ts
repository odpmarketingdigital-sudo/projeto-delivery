import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/email/config";
import {
  buildEmailConfirmationRedirect,
  CONFIRMATION_RATE_LIMIT_MESSAGE,
  CONFIRMATION_RESEND_COOLDOWN_SECONDS,
  getRequestOrigin,
  resendSignupConfirmation,
  type ConfirmationResendResult,
} from "@/lib/supabase/confirmation";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/auth/resend-confirmation — reenvia o e-mail de confirmação de
 * cadastro.
 *
 * Usado pela tela `/confirmar-email` (botão "Reenviar e-mail de confirmação").
 * O envio acontece **no servidor** com a service role
 * (`adminClient.auth.resend`), em vez do `supabase.auth.resend` do navegador:
 *
 *  - o erro do GoTrue chega com `status`/`code` completos, permitindo mensagens
 *    claras (antes a tela ficava sem aviso quando a chamada falhava ou estourava
 *    o rate limit);
 *  - respeitamos o cooldown local de 60 s por e-mail antes de incomodar o
 *    Supabase, que também responde 429 (`over_email_send_rate_limit`).
 *
 * Body: `{ email: string }`
 * Respostas:
 *  - 200 `{ ok: true, message, retry_after }`
 *  - 400 `{ error, code: "invalid_body" | "invalid_email" }`
 *  - 404 `{ error, code: "user_not_found" }` (e-mail sem conta)
 *  - 409 `{ error, code: "already_confirmed" }`
 *  - 429 `{ error: "Aguarde 1 minuto antes de solicitar um novo e-mail",
 *        code: "rate_limited", retry_after }` + header `Retry-After`
 *  - 502 `{ error, code: "send_failed" }` (falha de SMTP/provedor)
 *  - 503 `{ error, code: "email_disabled" }` (projeto sem envio de e-mail)
 */

/** Mesmo padrão de validação usado em `/api/signup` e no formulário. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Próximo instante permitido por e-mail (`Date.now() + cooldown`).
 *
 * Cooldown local em memória: barra o clique repetido dentro do mesmo processo
 * antes de gastar uma requisição no GoTrue. É best effort — com mais de uma
 * instância do servidor cada processo tem o seu mapa, e o rate limit do
 * Supabase continua sendo a proteção definitiva.
 */
const nextResendAt = new Map<string, number>();

/**
 * Resposta JSON com `no-store` (o estado muda assim que o e-mail sai) e,
 * quando houver, o header `Retry-After` — usado por clientes HTTP e pelo
 * navegador em novas tentativas automáticas.
 */
function respond(
  payload: Record<string, unknown>,
  status: number,
  retryAfterSeconds?: number
) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfterSeconds));
  }
  return NextResponse.json(payload, { status, headers });
}

/** Cooldown (em segundos) ainda ativo para o e-mail; 0 quando liberado. */
function remainingCooldownSeconds(email: string): number {
  const blockedUntil = nextResendAt.get(email) ?? 0;
  const remaining = Math.ceil((blockedUntil - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
}

/** Grava o cooldown do e-mail (e limpa entradas antigas para não crescer). */
function startCooldown(email: string, seconds: number) {
  const now = Date.now();
  for (const [key, until] of nextResendAt) {
    if (until <= now) nextResendAt.delete(key);
  }
  nextResendAt.set(email, now + seconds * 1000);
}

export async function POST(request: Request) {
  let body: { email?: unknown };
  try {
    body = await request.json();
  } catch {
    return respond(
      { error: "Corpo da requisição inválido (JSON esperado).", code: "invalid_body" },
      400
    );
  }

  // Normalizamos para minúsculas: o GoTrue trata e-mails sem diferenciar
  // maiúsculas, e assim o cooldown vale para "Loja@X.com" e "loja@x.com".
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!EMAIL_PATTERN.test(email)) {
    return respond(
      { error: "Informe o e-mail usado no cadastro.", code: "invalid_email" },
      400
    );
  }

  const cooldown = remainingCooldownSeconds(email);
  if (cooldown > 0) {
    return respond(
      {
        error: CONFIRMATION_RATE_LIMIT_MESSAGE,
        code: "rate_limited",
        retry_after: cooldown,
      },
      429,
      cooldown
    );
  }

  // Origem do link: domínio real da requisição; `NEXT_PUBLIC_APP_URL` como
  // fallback (mesma regra de `/api/signup`).
  const origin = getRequestOrigin(request) ?? getAppUrl();

  let result: ConfirmationResendResult;
  try {
    result = await resendSignupConfirmation(createAdminClient(), {
      email,
      emailRedirectTo: buildEmailConfirmationRedirect(origin),
    });
  } catch (unexpected) {
    // Falha inesperada (env ausente, Supabase indisponível, DNS…): devolve JSON
    // para a tela conseguir mostrar a mensagem, em vez de HTML de erro.
    console.error(
      "[api/auth/resend-confirmation] erro inesperado:",
      unexpected
    );
    return respond(
      {
        error:
          "Não foi possível enviar o e-mail de confirmação agora. Tente novamente em alguns minutos.",
        code: "send_failed",
      },
      502
    );
  }

  if (!result.ok) {
    if (result.code === "rate_limited") {
      const retryAfter =
        result.retryAfterSeconds ?? CONFIRMATION_RESEND_COOLDOWN_SECONDS;
      startCooldown(email, retryAfter);
      return respond(
        {
          error: CONFIRMATION_RATE_LIMIT_MESSAGE,
          code: result.code,
          retry_after: retryAfter,
        },
        429,
        retryAfter
      );
    }

    if (result.code === "already_confirmed") {
      return respond({ error: result.message, code: result.code }, 409);
    }

    if (result.code === "user_not_found") {
      return respond({ error: result.message, code: result.code }, 404);
    }

    if (result.code === "email_disabled") {
      console.error(
        "[api/auth/resend-confirmation] envio de e-mail desativado no Supabase:",
        result.message
      );
      return respond({ error: result.message, code: result.code }, 503);
    }

    console.error(
      "[api/auth/resend-confirmation] falha ao enviar o e-mail:",
      result.message
    );
    return respond({ error: result.message, code: result.code }, 502);
  }

  startCooldown(email, CONFIRMATION_RESEND_COOLDOWN_SECONDS);

  return respond(
    {
      ok: true,
      message: `Enviamos um novo link de confirmação para ${email}. Confira a caixa de entrada e o spam.`,
      retry_after: CONFIRMATION_RESEND_COOLDOWN_SECONDS,
    },
    200
  );
}
