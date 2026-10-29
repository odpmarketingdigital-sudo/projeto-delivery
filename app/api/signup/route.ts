import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/email/config";
import { sendWelcomeEmailSafely } from "@/lib/email/welcome";
import { createAdminClient } from "@/lib/supabase/server";
import { slugify } from "@/lib/slug";
import { addTrialDays } from "@/lib/subscriptions";

/**
 * POST /api/signup — cadastro público de restaurantes (SaaS de autoatendimento).
 *
 * Fluxo (tudo no servidor, com a service role key):
 *  1. Valida os dados do formulário de `/cadastro`.
 *  2. Garante que o slug do cardápio está livre (e não colide com rotas fixas).
 *  3. Cria a conta de acesso no Supabase Auth com `user_metadata.role =
 *     'admin'` — o trigger `handle_new_user` cria o perfil. A conta NÃO é
 *     auto-confirmada: com a opção "Confirm email" ativa no projeto ela nasce
 *     pendente (`email_confirmed_at` nulo) e o painel fica bloqueado até o
 *     clique no link enviado por e-mail.
 *  4. Dispara o e-mail de confirmação (`auth.resend`) somente quando a conta
 *     ainda está pendente. Ver `docs/confirmacao-email.md`.
 *  5. Insere o estabelecimento já em trial: `subscription_status = 'trialing'`
 *     e `trial_ends_at = now() + 30 dias`.
 *  6. Envia o e-mail de boas-vindas (Resend) — best effort: sem chave
 *     configurada ou com falha do provedor o cadastro segue normalmente,
 *     apenas registrando um aviso no log. Ver `docs/email-boas-vindas.md`.
 *
 * Resposta 201: `{ establishment, email_confirmation_required }`.
 *  - `email_confirmation_required: true` → o cliente NÃO faz login automático:
 *    redireciona para `/confirmar-email` e aguarda a confirmação.
 *  - `false` (projeto sem confirmação obrigatória) → o cliente faz
 *    `signInWithPassword` e entra direto no painel, como antes.
 *
 * Rollback: se o insert em `establishments` falhar, a conta criada em
 * `auth.users` é removida, evitando um usuário órfão ocupando o e-mail.
 *
 * Body: { owner_name, email, password, establishment_name, phone, slug }
 */

/** Rotas fixas da aplicação — não podem virar slug de cardápio. */
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "cadastro",
  "cardapio",
  "checkout",
  "clientes",
  "configuracoes",
  "cupons",
  "dashboard",
  "demo",
  "login",
  "painel",
  "pedido",
  "pedidos",
  "produtos",
]);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 80;
const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 60;
/** O Supabase Auth aceita no mínimo 6 caracteres (e no máximo 72 bytes). */
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 72;

/** Campos do formulário — devolvidos em `field` para destacar o erro na tela. */
type SignupField =
  | "owner_name"
  | "email"
  | "password"
  | "establishment_name"
  | "phone"
  | "slug";

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

/**
 * Detecta a migração de assinaturas não aplicada — sem ela o insert falha com
 * "column ... does not exist" / "Could not find the '...' column".
 */
function isMissingSubscriptionColumns(
  error: { message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  return (
    /(trial_ends_at|subscription_status|subscription_id|customer_payment_id|plan_id)/i.test(
      message
    ) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

export async function POST(request: Request) {
  // 1) Corpo da requisição.
  let body: {
    owner_name?: string;
    email?: string;
    password?: string;
    establishment_name?: string;
    phone?: string;
    slug?: string;
  };

  try {
    body = await request.json();
  } catch {
    return fail("Corpo da requisição inválido (JSON esperado).");
  }

  const ownerName = body.owner_name?.trim() ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const establishmentName = body.establishment_name?.trim() ?? "";
  const phone = body.phone?.trim() ?? "";
  const rawSlug = body.slug?.trim() ?? "";

  // 2) Validação dos campos.
  if (ownerName.length < MIN_NAME_LENGTH) {
    return fail("Informe o nome do responsável.", 400, "owner_name");
  }

  if (ownerName.length > MAX_NAME_LENGTH) {
    return fail(
      `O nome do responsável deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`,
      400,
      "owner_name"
    );
  }

  if (!EMAIL_PATTERN.test(email)) {
    return fail("Informe um e-mail válido.", 400, "email");
  }

  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return fail(
      `A senha deve ter entre ${MIN_PASSWORD_LENGTH} e ${MAX_PASSWORD_LENGTH} caracteres.`,
      400,
      "password"
    );
  }

  if (establishmentName.length < MIN_NAME_LENGTH) {
    return fail(
      "Informe o nome do estabelecimento.",
      400,
      "establishment_name"
    );
  }

  if (establishmentName.length > MAX_NAME_LENGTH) {
    return fail(
      `O nome do estabelecimento deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`,
      400,
      "establishment_name"
    );
  }

  // WhatsApp: 10 (fixo) ou 11 (celular) dígitos, com ou sem máscara.
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    return fail(
      "Informe o WhatsApp com DDD (10 ou 11 dígitos).",
      400,
      "phone"
    );
  }

  // 3) Slug do cardápio: normaliza, valida formato e rotas reservadas.
  const slug = slugify(rawSlug || establishmentName);

  if (slug.length < MIN_SLUG_LENGTH) {
    return fail(
      "O link do cardápio precisa ter ao menos 3 caracteres (letras ou números).",
      400,
      "slug"
    );
  }

  if (slug.length > MAX_SLUG_LENGTH) {
    return fail(
      `O link do cardápio deve ter no máximo ${MAX_SLUG_LENGTH} caracteres.`,
      400,
      "slug"
    );
  }

  if (!SLUG_PATTERN.test(slug)) {
    return fail(
      "Use apenas letras minúsculas, números e hífens no link do cardápio.",
      400,
      "slug"
    );
  }

  if (RESERVED_SLUGS.has(slug)) {
    return fail(
      `O link "${slug}" é reservado pela plataforma. Escolha outro.`,
      400,
      "slug"
    );
  }

  const adminClient = createAdminClient();

  /**
   * Origem pública usada no `emailRedirectTo` do link de confirmação.
   *
   * Em produção o `request.url` já traz o domínio correto (inclusive atrás do
   * proxy da Vercel); `NEXT_PUBLIC_APP_URL` fica como fallback.
   */
  let appOrigin = getAppUrl();
  try {
    appOrigin = new URL(request.url).origin;
  } catch {
    // Mantém `NEXT_PUBLIC_APP_URL`.
  }

  const { data: slugOwner } = await adminClient
    .from("establishments")
    .select("id")
    .eq("slug", slug)
    .limit(1)
    .maybeSingle();

  if (slugOwner) {
    return fail(`O link "${slug}" já está em uso. Escolha outro.`, 409, "slug");
  }

  // 4) Conta de acesso (Supabase Auth).
  //
  //    NÃO passamos `email_confirm: true`: isso confirmava o e-mail na criação
  //    e anulava a opção "Confirm email" do projeto. Sem o parâmetro, o GoTrue
  //    decide conforme a configuração — conta pendente quando a confirmação é
  //    obrigatória, já confirmada quando o projeto dispensa o passo.
  const { data: created, error: createError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      user_metadata: {
        name: ownerName,
        establishment: establishmentName,
        role: "admin",
      },
    });

  if (createError || !created.user) {
    if (isDuplicateEmailError(createError)) {
      return fail(
        "Este e-mail já possui uma conta. Faça login para continuar.",
        409,
        "email"
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

  const userId = created.user.id;

  /**
   * Conta pendente de confirmação?
   *
   * O `admin.createUser` NÃO envia e-mail de confirmação (diferente do signup
   * público). Por isso disparamos o `resend` explicitamente, apontando o link
   * para `/auth/callback`, que troca o token pela sessão e abre o painel.
   *
   * Em projetos com "Confirm email" desligado o GoTrue já confirma o usuário na
   * criação e nada é enviado — o cliente pode fazer o login automático.
   */
  const emailConfirmationRequired = !(
    created.user.email_confirmed_at ?? created.user.confirmed_at
  );

  if (emailConfirmationRequired) {
    const { error: confirmationError } = await adminClient.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: `${appOrigin}/auth/callback?next=/painel`,
      },
    });

    if (confirmationError) {
      // Best effort: sem SMTP configurado (ou com limite do provedor) o
      // cadastro continua válido e a tela `/confirmar-email` permite reenviar.
      console.warn(
        "[api/signup] falha ao enviar o e-mail de confirmação:",
        confirmationError.message
      );
    }
  }

  // Garante a linha em `profiles` (o trigger já cria; upsert por segurança).
  await adminClient.from("profiles").upsert(
    {
      id: userId,
      name: ownerName,
      email,
      role: "admin",
      establishment: establishmentName,
    },
    { onConflict: "id" }
  );

  // 5) Estabelecimento já em trial (30 dias grátis).
  const trialEndsAt = addTrialDays();

  const { data: inserted, error: insertError } = await adminClient
    .from("establishments")
    .insert({
      user_id: userId,
      name: establishmentName,
      owner_name: ownerName,
      email,
      phone,
      status: "ativo",
      slug,
      subscription_status: "trialing",
      trial_ends_at: trialEndsAt,
    })
    .select("id, name, slug, subscription_status, trial_ends_at")
    .single();

  if (insertError || !inserted) {
    // Rollback: sem loja a conta não serve para nada — remove para liberar o
    // e-mail e não deixar usuário órfão.
    await adminClient.auth.admin.deleteUser(userId);

    if (isMissingSubscriptionColumns(insertError)) {
      return NextResponse.json(
        {
          error:
            "As colunas de assinatura ainda não existem no banco. Execute a " +
            "migração 20261110000012_add_subscriptions_to_establishments.sql " +
            "no SQL Editor do Supabase.",
        },
        { status: 500 }
      );
    }

    // Corrida: outra loja tomou o slug entre a checagem e o insert.
    if (
      insertError?.code === "23505" &&
      /slug/i.test(insertError.message ?? "")
    ) {
      return fail(`O link "${slug}" já está em uso. Escolha outro.`, 409, "slug");
    }

    return fail(
      insertError?.message ?? "Não foi possível salvar o estabelecimento."
    );
  }

  // 6) E-mail de boas-vindas (Resend).
  //    Best effort: a conta e a loja já existem, então uma falha do provedor é
  //    apenas registrada no log (`console.warn`) — o cadastro responde 201 e o
  //    usuário entra no painel normalmente. Sem `RESEND_API_KEY` o envio é
  //    ignorado (ver docs/email-boas-vindas.md).
  await sendWelcomeEmailSafely({
    to: email,
    ownerName,
    establishmentName: inserted.name,
    slug: inserted.slug,
    trialEndsAt: inserted.trial_ends_at,
  });

  return NextResponse.json(
    {
      establishment: inserted,
      email_confirmation_required: emailConfirmationRequired,
    },
    { status: 201 }
  );
}
