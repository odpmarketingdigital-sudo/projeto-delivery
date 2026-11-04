import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType, User } from "@supabase/supabase-js";
import { hasEstablishmentForUser } from "@/lib/supabase/establishments";
import { createAdminClient, createClient } from "@/lib/supabase/server";

/**
 * GET /auth/callback — única porta de entrada depois de autenticar.
 *
 * O cadastro do Ipepper é **autenticação primeiro, loja depois**:
 *
 *  1. `/cadastro` (ou `/login`) autentica pelo Google (`signInWithOAuth`) ou
 *     por e-mail + senha;
 *  2. o Google devolve o usuário aqui (`?code=...`, fluxo PKCE);
 *  3. esta rota troca o código pela sessão e consulta `establishments` pelo
 *     `user_id` do usuário — a fonte da verdade é o **banco**, nunca um
 *     rascunho guardado no navegador;
 *  4. com loja → `next` (padrão `/painel`); sem loja → `/completar-cadastro`.
 *
 * Nada de cookies temporários: quem se cadastra pelo Google só chega ao painel
 * depois que a loja existe de fato, e quem cai no onboarding o preenche com a
 * sessão já ativa (o vínculo é feito pelo `user_id` no servidor).
 *
 * Também trata os links enviados por e-mail, com dois formatos aceitos:
 *  - `?code=...` → PKCE usado pelo cliente do `@supabase/ssr`
 *    (o *code verifier* fica em cookie);
 *  - `?token_hash=...&type=...` → fluxo por OTP, que funciona mesmo quando o
 *    link é aberto em outro navegador/dispositivo (sem o cookie do verifier).
 *    É o formato usado pelos templates de e-mail, porque a confirmação de
 *    cadastro costuma acontecer fora do navegador do signup:
 *
 *    ```html
 *    <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup&next=/painel">
 *      Confirmar e-mail
 *    </a>
 *    ```
 *
 * Em caso de falha, volta para uma tela útil com `?erro=link-invalido`:
 * `/nova-senha` (recuperação) ou `/confirmar-email` (confirmação), onde o
 * usuário pode pedir um novo link. Se o usuário cancelar no Google, o provedor
 * devolve `?error=access_denied` e voltamos para `/cadastro?erro=access_denied`.
 */

/** Destino de links de recuperação de senha. */
const DEFAULT_RECOVERY_NEXT = "/nova-senha";
/** Destino de quem já tem estabelecimento (OAuth e confirmação de e-mail). */
const DEFAULT_POST_AUTH_NEXT = "/painel";
/** Onboarding obrigatório de quem ainda não tem loja. */
const ONBOARDING_NEXT = "/completar-cadastro";
/** Tela de origem do login com Google (mostra o aviso de falha). */
const OAUTH_FAILURE_NEXT = "/cadastro";

/**
 * Tipos de OTP aceitos em `?type=`.
 *
 * - `signup` / `email` / `invite` / `magiclink` → confirmam a conta;
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
 * Consulta a loja do usuário com a **service role** (bypass de RLS).
 *
 * `true` = já existe loja; `false` = não existe; `null` = não deu para
 * consultar. O que importa é a linha existir de fato, não o que a sessão
 * recém-criada enxerga (políticas de RLS variam entre ambientes).
 */
async function confirmEstablishment(userId: string): Promise<boolean | null> {
  try {
    const hasStore = await hasEstablishmentForUser(
      createAdminClient(),
      userId
    );

    console.log(
      "[auth/callback] loja do usuário:",
      hasStore === null
        ? "desconhecida (falha na consulta)"
        : hasStore
          ? "encontrada"
          : "ausente",
      { userId }
    );

    return hasStore;
  } catch (error) {
    console.error("[auth/callback] falha ao consultar a loja do usuário", error, {
      userId,
    });
    return null;
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
    otpType === "recovery" ? DEFAULT_RECOVERY_NEXT : DEFAULT_POST_AUTH_NEXT;

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

  // Falhou (link expirado/reutilizado/código inválido): manda para a tela que
  // permite pedir um novo link.
  if (!user) {
    const failureUrl = new URL(
      otpType === "recovery" ? DEFAULT_RECOVERY_NEXT : "/confirmar-email",
      origin
    );
    failureUrl.searchParams.set("erro", "link-invalido");

    return NextResponse.redirect(failureUrl);
  }

  console.log("[auth/callback] sessão criada", {
    userId: user.id,
    provider: user.app_metadata?.provider,
    otpType,
    isCodeFlow,
    next,
  });

  // Recuperação de senha nunca passa pelo onboarding — a conta já existe.
  if (otpType === "recovery") {
    return NextResponse.redirect(new URL(next, origin));
  }

  const hasStore = await confirmEstablishment(user.id);

  // Conta com loja (login comum, confirmação de e-mail ou OAuth recorrente):
  // segue direto para o destino pedido.
  if (hasStore === true) {
    console.log("[auth/callback] conta com loja — indo para", next);
    return NextResponse.redirect(new URL(next, origin));
  }

  /**
   * `false` (sem loja) e `null` (não deu para confirmar) vão para o onboarding
   * — nunca para o painel. `/completar-cadastro` reconsulta o banco e devolve
   * ao painel quando a loja existir, então este destino é sempre seguro: não
   * existe laço nem tela de "Nenhum estabelecimento associado à sua conta".
   */
  console.warn(
    "[auth/callback] conta sem loja confirmada — indo para o onboarding",
    { userId: user.id, storeCheck: hasStore === null ? "falhou" : "sem loja" }
  );

  return NextResponse.redirect(new URL(ONBOARDING_NEXT, origin));
}

