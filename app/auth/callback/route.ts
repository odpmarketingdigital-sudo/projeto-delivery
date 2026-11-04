import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType, User } from "@supabase/supabase-js";
import { sendWelcomeEmailSafely } from "@/lib/email/welcome";
import {
  ownerNameError,
  resolveOwnerName,
  validateEstablishmentDraft,
} from "@/lib/registration";
import {
  findEstablishmentForUser,
  saveEstablishmentForUser,
} from "@/lib/supabase/establishments";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import {
  decodeSignupDraftCookie,
  SIGNUP_DRAFT_COOKIE,
} from "@/lib/signupDraft";

/** Destino padrão de links de recuperação de senha. */
const DEFAULT_RECOVERY_NEXT = "/nova-senha";
/** Destino padrão dos links de confirmação de e-mail: o painel. */
const DEFAULT_CONFIRMATION_NEXT = "/painel";
/**
 * Destino padrão do retorno do OAuth (Google): o painel.
 *
 * O Google volta como `?code=...` (PKCE) e sem `type`. Se o botão não enviar
 * `next` — ou enviar um destino inválido — o usuário cai em `/painel`. Contas
 * que ainda não têm loja passam antes por `ONBOARDING_NEXT`, que também conclui
 * o fluxo em `/painel`.
 */
const DEFAULT_OAUTH_NEXT = "/painel";
/** Onboarding quando a conta ainda não tem estabelecimento (ex.: Google). */
const ONBOARDING_NEXT = "/completar-cadastro";
/** Tela de origem do login com Google (mostra o aviso de falha). */
const OAUTH_FAILURE_NEXT = "/cadastro";

/**
 * Tipos de OTP aceitos em `?type=`.
 *
 * - `signup` / `email` / `invite` / `magiclink` → confirmam a conta e liberam
 *   o painel (é o que o link de confirmação do cadastro usa);
 * - `recovery` → fluxo de nova senha;
 * - `email_change` → troca de e-mail de um usuário já autenticado.
 */
const OTP_TYPES = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value !== null && OTP_TYPES.has(value as EmailOtpType);
}

/**
 * Só aceita caminhos internos (evita open redirect).
 *
 * Rejeita URLs absolutas (`https://...`) e URLs protocol-relative (`//evil`).
 */
function safeNextPath(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}

/**
 * Destinos que NÃO fazem sentido depois de autenticar: telas de entrada e o
 * próprio callback. Se `next` apontar para um deles, usamos o fallback
 * (`/painel`), evitando vaivém de redirects com o middleware.
 */
const NON_POST_AUTH_PREFIXES = [
  "/login",
  "/cadastro",
  "/auth",
  "/confirmar-email",
];

function isPostAuthDestination(value: string): boolean {
  return !NON_POST_AUTH_PREFIXES.some(
    (prefix) => value === prefix || value.startsWith(`${prefix}/`)
  );
}

/**
 * GET /auth/callback
 *
 * Rota de retorno dos links enviados por e-mail:
 *  - **confirmação de cadastro** (`type=signup`) → abre o painel;
 *  - **recuperação de senha** (`type=recovery`) → abre `/nova-senha`.
 *
 * Troca o código/token pela sessão do Supabase e redireciona para `next`
 * (com fallback conforme o tipo do link).
 *
 * Dois formatos são aceitos:
 *  - `?code=...` → fluxo PKCE usado pelo cliente do `@supabase/ssr`
 *    (o *code verifier* fica em cookie);
 *  - `?token_hash=...&type=...` → fluxo por OTP, que funciona mesmo quando o
 *    link é aberto em outro navegador/dispositivo (sem o cookie do verifier).
 *    É o formato usado pelos templates de e-mail abaixo, porque a confirmação
 *    de cadastro costuma acontecer fora do navegador do signup:
 *
 *    ```html
 *    <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup&next=/painel">
 *      Confirmar e-mail
 *    </a>
 *    ```
 *
 * Em caso de falha, volta para uma tela útil com `?erro=link-invalido`:
 * `/nova-senha` (recuperação) ou `/confirmar-email` (confirmação), onde o
 * usuário pode pedir um novo link.
 *
 * **Login com Google (OAuth):** o botão de `/cadastro` chama
 * `signInWithOAuth({ redirectTo: "/auth/callback?next=/painel" })`, então o
 * retorno chega como `?code=...` (PKCE). O destino pós-login é SEMPRE o painel:
 * `next` é usado quando é um caminho interno válido; caso contrário (ausente,
 * externo ou uma tela de entrada) cai em `DEFAULT_OAUTH_NEXT` (`/painel`).
 * Depois de trocar o código pela sessão, a rota consulta `establishments`:
 *  - conta **sem** loja, mas com rascunho salvo por `/cadastro` antes do OAuth
 *    (cookie `SIGNUP_DRAFT_COOKIE`, ver `lib/signupDraft.ts`) → a loja é criada
 *    AQUI, já vinculada ao `user_id` do Google, e o usuário vai para `/painel`;
 *  - conta **sem** loja e sem rascunho (ex.: login direto) → `/completar-cadastro`,
 *    onde o usuário informa os dados do estabelecimento (a tela conclui em
 *    `/painel`);
 *  - conta **com** loja → `next` (painel).
 *
 * Se o usuário cancelar no Google, o provedor devolve `?error=access_denied`;
 * nesse caso voltamos para `/cadastro?erro=google`.
 */

/**
 * `true` = já existe loja; `false` = pode criar; `null` = não deu para consultar
 * o banco (falha de infraestrutura não deve bloquear o acesso).
 */
async function hasEstablishment(userId: string): Promise<boolean | null> {
  try {
    const adminClient = createAdminClient();
    return Boolean(await findEstablishmentForUser(adminClient, userId));
  } catch (error) {
    // Falha de infraestrutura não deve bloquear o acesso: segue para `next`.
    console.error("[auth/callback] falha ao verificar estabelecimento", error);
    return null;
  }
}

/**
 * Cria o estabelecimento do usuário recém-criado pelo Google a partir do
 * rascunho que `/cadastro` guardou antes do redirect (sessionStorage + cookie).
 *
 * O servidor NÃO confia no conteúdo do cookie: o rascunho é revalidado com as
 * mesmas regras do formulário (`lib/registration.ts`) antes da gravação.
 *
 * `true` = loja salva (o usuário pode ir direto para o painel); `false` = não
 * foi possível concluir e o fluxo continua em `/completar-cadastro`.
 */
async function createEstablishmentFromDraft(
  userId: string,
  user: User,
  draftToken: string
): Promise<boolean> {
  const draft = decodeSignupDraftCookie(draftToken);

  if (!draft) {
    console.warn("[auth/callback] rascunho de cadastro inválido — indo ao onboarding");
    return false;
  }

  const draftErrors = validateEstablishmentDraft(draft);
  if (Object.keys(draftErrors).length > 0) {
    console.warn("[auth/callback] rascunho reprovado na validação", draftErrors);
    return false;
  }

  const email = user.email ?? "";
  const ownerName = resolveOwnerName(user.user_metadata, email);

  // Sem nome de responsável utilizável a loja ficaria sem dono em `profiles`.
  if (ownerNameError(ownerName)) {
    console.warn("[auth/callback] conta do Google sem nome de responsável");
    return false;
  }

  try {
    const saved = await saveEstablishmentForUser(createAdminClient(), userId, {
      name: draft.name,
      ownerName,
      email,
      whatsapp: draft.whatsapp,
      documentType: draft.document_type,
      documentNumber: draft.document_number,
      slug: draft.slug,
    });

    if (!saved.ok) {
      console.error(
        "[auth/callback] falha ao salvar a loja do Google:",
        saved.code,
        saved.error
      );
      return false;
    }

    if (saved.warning) console.warn("[auth/callback]", saved.warning);

    // Mesmo e-mail de boas-vindas do cadastro por e-mail (`POST /api/signup`),
    // sempre best effort — uma falha do Resend não desfaz a loja.
    if (saved.created && email) {
      await sendWelcomeEmailSafely({
        to: email,
        ownerName,
        establishmentName: saved.establishment.name,
        slug: saved.establishment.slug,
        trialEndsAt: saved.establishment.trial_ends_at,
      });
    }

    return true;
  } catch (error) {
    console.error("[auth/callback] falha ao salvar a loja do Google", error);
    return false;
  }
}

/**
 * Redirect de saída do fluxo de cadastro.
 *
 * O rascunho é de uso único: depois que a sessão existe (e a loja foi criada ou
 * o usuário seguiu para o onboarding) não há motivo para manter CPF/CNPJ e
 * WhatsApp no navegador — o cookie é apagado junto com a resposta.
 */
function redirectEndingSignup(url: URL): NextResponse {
  const response = NextResponse.redirect(url);

  // Mesmos atributos usados na escrita (`lib/signupDraft.ts`): um cookie
  // `Secure` só pode ser sobrescrito (inclusive para apagar) por outro `Secure`.
  response.cookies.set(SIGNUP_DRAFT_COOKIE, "", {
    path: "/",
    maxAge: 0,
    sameSite: "lax",
    secure: url.protocol === "https:",
  });

  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const providerError = searchParams.get("error");

  const otpType = isEmailOtpType(type) ? type : null;
  // OAuth (Google) e recuperação de senha usam PKCE: chegam com `code` e sem
  // `type`. Só o fluxo por OTP (`token_hash` + `type`) identifica o tipo pela
  // URL — por isso o `code` sem `type` tem fallback próprio (o painel).
  const isCodeFlow = Boolean(code) && otpType === null;

  const fallbackNext =
    otpType === "recovery"
      ? DEFAULT_RECOVERY_NEXT
      : isCodeFlow
        ? DEFAULT_OAUTH_NEXT
        : DEFAULT_CONFIRMATION_NEXT;

  const requestedNext = searchParams.get("next");
  // `next` só é aceito se for um caminho interno que faça sentido pós-login;
  // caso contrário o usuário segue para o fallback (`/painel`).
  const candidateNext =
    requestedNext && isPostAuthDestination(requestedNext) ? requestedNext : null;
  const next = safeNextPath(candidateNext, fallbackNext);

  // Cancelamento/erro devolvido pelo provedor OAuth (Google).
  if (providerError) {
    const failureUrl = new URL(OAUTH_FAILURE_NEXT, origin);
    failureUrl.searchParams.set("erro", providerError);
    return NextResponse.redirect(failureUrl);
  }

  const supabase = await createClient();

  let user: User | null = null;

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      user = data.user ?? data.session?.user ?? null;
    }
  } else if (tokenHash && otpType) {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });
    if (!error) {
      user = data.user ?? data.session?.user ?? null;
    }
  }

  if (user) {
    // Recuperação de senha nunca passa pelo onboarding — a conta já existe.
    if (otpType === "recovery") {
      return NextResponse.redirect(new URL(next, origin));
    }

    const hasStore = await hasEstablishment(user.id);

    // Conta que já tem loja (login comum) — e também o caso em que não deu para
    // consultar o banco (`null`) — segue direto para o destino pedido.
    if (hasStore !== false) {
      return redirectEndingSignup(new URL(next, origin));
    }

    // Conta sem loja: se `/cadastro` guardou o rascunho antes do OAuth, a loja
    // é criada agora e o usuário cai direto no painel, sem refazer o cadastro.
    const draftToken = request.cookies.get(SIGNUP_DRAFT_COOKIE)?.value;

    if (draftToken) {
      const created = await createEstablishmentFromDraft(
        user.id,
        user,
        draftToken
      );

      if (created) {
        return redirectEndingSignup(new URL(DEFAULT_OAUTH_NEXT, origin));
      }
    }

    // Sem rascunho (ou rascunho recusado): completa os dados numa tela própria.
    return redirectEndingSignup(new URL(ONBOARDING_NEXT, origin));
  }

  // Falhou (link expirado/reutilizado): manda para a tela que permite pedir
  // um novo link.
  const failureUrl = new URL(
    otpType === "recovery" ? DEFAULT_RECOVERY_NEXT : "/confirmar-email",
    origin
  );
  failureUrl.searchParams.set("erro", "link-invalido");

  return NextResponse.redirect(failureUrl);
}
