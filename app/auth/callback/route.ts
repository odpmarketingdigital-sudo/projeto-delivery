import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { findEstablishmentForUser } from "@/lib/supabase/establishments";
import { createAdminClient, createClient } from "@/lib/supabase/server";

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
 *  - conta **sem** loja (primeiro acesso pelo Google) → `/completar-cadastro`,
 *    onde o usuário informa os dados do estabelecimento (a tela conclui em
 *    `/painel`);
 *  - conta **com** loja → `next` (painel).
 *
 * Se o usuário cancelar no Google, o provedor devolve `?error=access_denied`;
 * nesse caso voltamos para `/cadastro?erro=google`.
 */
async function hasEstablishment(userId: string): Promise<boolean> {
  try {
    const adminClient = createAdminClient();
    return Boolean(await findEstablishmentForUser(adminClient, userId));
  } catch (error) {
    // Falha de infraestrutura não deve bloquear o acesso: segue para `next`.
    console.error("[auth/callback] falha ao verificar estabelecimento", error);
    return true;
  }
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

  let userId: string | null = null;

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      userId = data.user?.id ?? data.session?.user.id ?? null;
    }
  } else if (tokenHash && otpType) {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });
    if (!error) {
      userId = data.user?.id ?? data.session?.user.id ?? null;
    }
  }

  if (userId) {
    // Recuperação de senha nunca passa pelo onboarding — a conta já existe.
    if (otpType === "recovery") {
      return NextResponse.redirect(new URL(next, origin));
    }

    // Primeiro acesso pelo Google: falta criar a loja.
    if (!(await hasEstablishment(userId))) {
      return NextResponse.redirect(new URL(ONBOARDING_NEXT, origin));
    }

    return NextResponse.redirect(new URL(next, origin));
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
