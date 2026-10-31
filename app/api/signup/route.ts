import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/email/config";
import { sendWelcomeEmailSafely } from "@/lib/email/welcome";
import {
  emailError,
  normalizeEstablishmentDraft,
  ownerNameError,
  passwordError,
  validateEstablishmentDraft,
  type DocumentType,
  type EstablishmentDraft,
} from "@/lib/registration";
import {
  buildEmailConfirmationRedirect,
  getRequestOrigin,
  resendSignupConfirmation,
} from "@/lib/supabase/confirmation";
import { saveEstablishmentForUser } from "@/lib/supabase/establishments";
import { createAdminClient } from "@/lib/supabase/server";

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
 *  4. Dispara o e-mail de confirmação (`lib/supabase/confirmation.ts`) somente
 *     quando a conta ainda está pendente. Ver `docs/confirmacao-email.md`.
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
 * Body: { owner_name, email, password, establishment_name, document_type,
 *         document_number, whatsapp, slug }
 *
 * Validações e máscaras vêm de `lib/registration.ts` — o mesmo módulo usado
 * pelo formulário `/cadastro` e pelo onboarding `/completar-cadastro`.
 */

/** Campos do formulário — devolvidos em `field` para destacar o erro na tela. */
type SignupField =
  | "owner_name"
  | "email"
  | "password"
  | "establishment_name"
  | "document_type"
  | "document_number"
  | "whatsapp"
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

export async function POST(request: Request) {
  // 1) Corpo da requisição.
  let body: {
    owner_name?: string;
    email?: string;
    password?: string;
    establishment_name?: string;
    /** Alias aceito para `establishment_name` (mesmo nome da coluna). */
    name?: string;
    document_type?: string;
    document_number?: string;
    whatsapp?: string;
    /** Alias legado de `whatsapp` (formulário antigo). */
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
  const establishmentName = (body.establishment_name ?? body.name ?? "").trim();
  const rawWhatsapp = (body.whatsapp ?? body.phone ?? "").trim();
  const rawSlug = body.slug?.trim() ?? "";
  const rawDocumentType = (body.document_type ?? "").trim().toLowerCase();

  // 2) Validação dos campos — mesmas regras/mensagens do formulário.
  const ownerMessage = ownerNameError(ownerName);
  if (ownerMessage) return fail(ownerMessage, 400, "owner_name");

  const emailMessage = emailError(email);
  if (emailMessage) return fail(emailMessage, 400, "email");

  const passwordMessage = passwordError(password);
  if (passwordMessage) return fail(passwordMessage, 400, "password");

  if (
    rawDocumentType &&
    rawDocumentType !== "cpf" &&
    rawDocumentType !== "cnpj"
  ) {
    return fail("Escolha CPF ou CNPJ.", 400, "document_type");
  }

  const documentType: DocumentType =
    rawDocumentType === "cnpj" ? "cnpj" : "cpf";

  const draft: EstablishmentDraft = {
    name: establishmentName,
    document_type: documentType,
    document_number: body.document_number ?? "",
    whatsapp: rawWhatsapp,
    slug: rawSlug,
  };

  // O slug é derivado do nome quando o campo vem vazio.
  const draftErrors = validateEstablishmentDraft(draft);

  if (draftErrors.name) {
    return fail(draftErrors.name, 400, "establishment_name");
  }
  if (draftErrors.document_number) {
    return fail(draftErrors.document_number, 400, "document_number");
  }
  if (draftErrors.whatsapp) {
    return fail(draftErrors.whatsapp, 400, "whatsapp");
  }
  if (draftErrors.slug) {
    return fail(draftErrors.slug, 400, "slug");
  }

  const normalized = normalizeEstablishmentDraft(draft);
  const slug = normalized.slug;

  const adminClient = createAdminClient();

  /**
   * Origem pública usada no `emailRedirectTo` do link de confirmação.
   *
   * Em produção o `request.url` já traz o domínio correto (inclusive atrás do
   * proxy da Vercel); `NEXT_PUBLIC_APP_URL` fica como fallback.
   */
  const appOrigin = getRequestOrigin(request) ?? getAppUrl();

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
    // Mesma função usada por `POST /api/auth/resend-confirmation`: cadastro e
    // botão "Reenviar" têm exatamente o mesmo comportamento.
    const confirmation = await resendSignupConfirmation(adminClient, {
      email,
      emailRedirectTo: buildEmailConfirmationRedirect(appOrigin),
    });

    if (!confirmation.ok) {
      // Best effort: sem SMTP configurado (ou com limite do provedor) o
      // cadastro continua válido e a tela `/confirmar-email` permite reenviar.
      console.warn(
        "[api/signup] falha ao enviar o e-mail de confirmação:",
        confirmation.code,
        confirmation.message
      );
    }
  }

  // 5) Estabelecimento já em trial (30 dias grátis).
  //
  //    `saveEstablishmentForUser` (lib/supabase/establishments.ts) concentra o
  //    insert/update, o trial, a checagem de slug e a sincronização de
  //    `profiles` + metadados (`role: admin` / `onboarding_complete: true`).
  const saved = await saveEstablishmentForUser(adminClient, userId, {
    name: normalized.name,
    ownerName,
    email,
    whatsapp: normalized.whatsapp,
    documentType: normalized.documentType,
    documentNumber: normalized.documentNumber,
    slug,
  });

  if (!saved.ok) {
    // Rollback: sem loja a conta não serve para nada — remove para liberar o
    // e-mail e não deixar usuário órfão.
    await adminClient.auth.admin.deleteUser(userId);

    // `saved.field` cobre slug e CPF/CNPJ (índices únicos) para destacar o
    // campo certo no formulário de `/cadastro`.
    if (saved.field) {
      return fail(saved.error, saved.status, saved.field);
    }

    return fail(saved.error, saved.status);
  }

  const inserted = saved.establishment;

  if (saved.warning) {
    console.warn("[api/signup]", saved.warning);
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
