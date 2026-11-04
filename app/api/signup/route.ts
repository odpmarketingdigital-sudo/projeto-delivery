import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/email/config";
import { emailError, passwordError } from "@/lib/registration";
import {
  buildEmailConfirmationRedirect,
  getRequestOrigin,
  resendSignupConfirmation,
} from "@/lib/supabase/confirmation";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/signup — criação da **conta de acesso** (e-mail + senha).
 *
 * Primeira etapa do cadastro: o usuário cria o acesso e só depois informa os
 * dados da loja em `/completar-cadastro`. Nada é gravado em `establishments`
 * aqui — a loja nasce em `POST /api/signup/establishment`, já com a sessão do
 * usuário, o que garante o vínculo correto (`establishments.user_id`) em
 * qualquer caminho de entrada (Google, e-mail/senha, link de confirmação).
 *
 * Fluxo (tudo no servidor, com a service role key):
 *  1. Valida e-mail e senha (`lib/registration.ts` — mesmas regras da tela).
 *  2. Cria a conta no Supabase Auth com `user_metadata.role = 'admin'` — o
 *     trigger `handle_new_user` cria a linha em `profiles`. A conta NÃO é
 *     auto-confirmada: com "Confirm email" ativo no projeto ela nasce pendente
 *     (`email_confirmed_at` nulo) e o painel fica bloqueado até o clique no
 *     link enviado por e-mail.
 *  3. Dispara o e-mail de confirmação (`lib/supabase/confirmation.ts`) somente
 *     quando a conta ainda está pendente. Ver `docs/confirmacao-email.md`.
 *
 * Resposta 201: `{ email_confirmation_required }`.
 *  - `true` → o cliente redireciona para `/confirmar-email` e aguarda o clique
 *    no link (o `/auth/callback` depois decide entre painel e onboarding);
 *  - `false` (projeto sem confirmação obrigatória) → o cliente faz
 *    `signInWithPassword` e segue para `/completar-cadastro`.
 *
 * E-mail de boas-vindas: NÃO é enviado aqui. Ele pertence à criação da loja
 * (`POST /api/signup/establishment`), quando já existe cardápio para divulgar.
 *
 * Body: { email, password }
 */

/** Campos do formulário — devolvidos em `field` para destacar o erro na tela. */
type SignupField = "email" | "password";

/** Resposta de erro padronizada (com o campo culpado, quando houver). */
function fail(message: string, status = 400, field?: SignupField) {
  return NextResponse.json(
    { error: message, ...(field ? { field } : {}) },
    { status }
  );
}

/** Detecta e-mail já cadastrado (GoTrue responde 422 com `email_exists`). */
function isDuplicateEmailError(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  if (!error) return false;
  const message = (error.message ?? "").toLowerCase();
  return (
    error.code === "email_exists" ||
    error.code === "user_already_exists" ||
    message.includes("already registered") ||
    message.includes("already been registered")
  );
}

/** Detecta senha recusada pelo GoTrue (política do projeto). */
function isWeakPasswordError(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  if (!error) return false;
  const message = (error.message ?? "").toLowerCase();
  return error.code === "weak_password" || message.includes("password should be");
}

export async function POST(request: Request) {
  // 1) Corpo da requisição.
  let body: { email?: unknown; password?: unknown };

  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return fail("Corpo da requisição inválido (JSON esperado).");
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // 2) Validação dos campos — mesmas regras/mensagens do formulário.
  const emailMessage = emailError(email);
  if (emailMessage) return fail(emailMessage, 400, "email");

  const passwordMessage = passwordError(password);
  if (passwordMessage) return fail(passwordMessage, 400, "password");

  const adminClient = createAdminClient();

  /**
   * Origem pública usada no `emailRedirectTo` do link de confirmação.
   *
   * Em produção o `request.url` já traz o domínio correto (inclusive atrás do
   * proxy da Vercel); `NEXT_PUBLIC_APP_URL` fica como fallback. O destino do
   * link é `/auth/callback`, que decide entre painel e onboarding.
   */
  const appOrigin = getRequestOrigin(request) ?? getAppUrl();

  // 3) Conta de acesso (Supabase Auth).
  //
  //    NÃO passamos `email_confirm: true`: isso confirmava o e-mail na criação
  //    e anulava a opção "Confirm email" do projeto. Sem o parâmetro, o GoTrue
  //    decide conforme a configuração — conta pendente quando a confirmação é
  //    obrigatória, já confirmada quando o projeto dispensa o passo.
  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      user_metadata: { role: "admin" },
    });

  if (createError || !created.user) {
    if (isDuplicateEmailError(createError)) {
      // `code` permite à tela oferecer o login com a senha digitada em vez de
      // deixar o usuário num beco sem saída.
      return NextResponse.json(
        {
          error: "Este e-mail já possui uma conta.",
          field: "email",
          code: "email_exists",
        },
        { status: 409 }
      );
    }

    if (isWeakPasswordError(createError)) {
      return fail(
        "Senha recusada pelo serviço de autenticação. Use uma senha mais forte.",
        400,
        "password"
      );
    }

    return fail(
      createError?.message ?? "Não foi possível criar a conta de acesso."
    );
  }

  /**
   * Conta pendente de confirmação?
   *
   * O `admin.createUser` NÃO envia e-mail de confirmação (diferente do signup
   * público). Por isso disparamos o `resend` explicitamente, apontando o link
   * para `/auth/callback?next=/painel`, que troca o token pela sessão e decide
   * o destino conforme a loja existir ou não.
   *
   * Em projetos com "Confirm email" desligado o GoTrue já confirma o usuário na
   * criação e nada é enviado — o cliente pode fazer o login automático.
   */
  const emailConfirmationRequired = !(
    created.user.email_confirmed_at ?? created.user.confirmed_at
  );

  if (emailConfirmationRequired) {
    // Mesma função usada por `POST /api/auth/resend-confirmation`: cadastro e
    // botão "Reenviar" têm exatamente o mesmo comportamento.
    const confirmation = await resendSignupConfirmation(adminClient, {
      email,
      emailRedirectTo: buildEmailConfirmationRedirect(appOrigin),
    });

    if (!confirmation.ok) {
      // Best effort: sem SMTP configurado (ou com limite do provedor) a conta
      // continua válida e a tela `/confirmar-email` permite reenviar.
      console.warn(
        "[api/signup] falha ao enviar o e-mail de confirmação:",
        confirmation.code,
        confirmation.message
      );
    }
  }

  return NextResponse.json(
    { email_confirmation_required: emailConfirmationRequired },
    { status: 201 }
  );
}

