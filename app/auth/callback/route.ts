import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /auth/callback — troca o código/token do Supabase pela sessão.
 *
 * O cadastro do Ipepper é **autenticação primeiro, loja depois** e o destino
 * pós-login tem uma única fonte da verdade: `/auth/continuar`, resolvida no
 * middleware (`decidePostAuth`). Esta rota, por isso, **não consulta o banco** e
 * **não escolhe** entre painel e onboarding — ela autentica e responde com um
 * **307 direto para `/auth/continuar`**:
 *
 *  1. `/cadastro` (ou `/login`) autentica pelo Google (`signInWithOAuth`) ou
 *     por e-mail + senha;
 *  2. o Google (ou o link do e-mail) devolve o usuário aqui, com `?code=...`
 *     (PKCE) ou `?token_hash=...&type=...` (OTP);
 *  3. `exchangeCodeForSession`/`verifyOtp` gravam a sessão nos cookies — é isso
 *     que libera o acesso ao painel;
 *  4. sucesso → **307 `Location: /auth/continuar`**. Lá o middleware consulta
 *     `establishments` pelo `user_id` da sessão e decide `/painel` (tem loja),
 *     `/completar-cadastro` (sem loja) ou `/painel/admin` (super_admin).
 *
 * Regra dura: nunca redirecionar para a raiz (`/`) nem devolver o usuário para
 * a origem da requisição. Depois de autenticar, o único destino é
 * `/auth/continuar` — a exceção é a recuperação de senha, que precisa abrir
 * `/nova-senha` para o usuário definir a nova senha antes de seguir.
 *
 * Os dois formatos de link aceitos:
 *  - `?code=...` → PKCE usado pelo cliente do `@supabase/ssr`
 *    (o *code verifier* fica em cookie);
 *  - `?token_hash=...&type=...` → fluxo por OTP, que funciona mesmo quando o
 *    link é aberto em outro navegador/dispositivo (sem o cookie do verifier).
 *    É o formato usado pelos templates de e-mail, porque a confirmação de
 *    cadastro costuma acontecer fora do navegador do signup:
 *
 *    ```html
 *    <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup">
 *      Confirmar e-mail
 *    </a>
 *    ```
 *
 * Em caso de falha, volta para uma tela útil com `?erro=link-invalido`:
 * `/nova-senha` (recuperação) ou `/confirmar-email` (confirmação), onde o
 * usuário pode pedir um novo link. Se o usuário cancelar no Google, o provedor
 * devolve `?error=access_denied` e voltamos para `/cadastro?erro=access_denied`.
 */

/**
 * Porta única de decisão pós-autenticação (resolvida no middleware, com um
 * redirect 307 próprio). Não existe página nesse caminho.
 */
const POST_AUTH_PATH = "/auth/continuar";
/** Recuperação de senha: a senha nova vem antes de qualquer outro destino. */
const RECOVERY_PATH = "/nova-senha";
/** Aviso de e-mail pendente + reenvio do link de confirmação. */
const CONFIRM_EMAIL_PATH = "/confirmar-email";
/** Tela de origem do login com Google (mostra o aviso de falha). */
const OAUTH_FAILURE_PATH = "/cadastro";
/** Marca que o link estava expirado, reutilizado ou inválido. */
const INVALID_LINK_ERROR = "link-invalido";

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
 * Redirect **307** para um caminho interno do próprio app.
 *
 * A URL é montada a partir da requisição — mesmo host e protocolo, inclusive
 * atrás de proxy/`www` — e o caminho é fixo em código: não há fallback para `/`
 * nem para a origem da requisição. O 307 preserva o método e o corpo da
 * requisição (o `GET` do link, com os cookies de sessão recém-gravados).
 */
function redirectToPath(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url, 307);
}

/** Redirect para uma tela de aviso, com `?erro=...`. */
function redirectToError(request: NextRequest, pathname: string, error: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  url.searchParams.set("erro", error);
  return NextResponse.redirect(url, 307);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const providerError = searchParams.get("error");

  const otpType = isEmailOtpType(type) ? type : null;

  // Cancelamento/erro devolvido pelo provedor OAuth (Google).
  if (providerError) {
    return redirectToError(request, OAUTH_FAILURE_PATH, providerError);
  }

  const supabase = await createClient();

  let user: User | null = null;

  if (code) {
    // Fluxo PKCE (Google e link de recuperação do Supabase).
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      user = data.user ?? data.session?.user ?? null;
    }
  } else if (tokenHash && otpType) {
    // Fluxo por OTP (templates de e-mail com `token_hash`).
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
    return redirectToError(
      request,
      otpType === "recovery" ? RECOVERY_PATH : CONFIRM_EMAIL_PATH,
      INVALID_LINK_ERROR
    );
  }

  console.log("[auth/callback] sessão criada", {
    userId: user.id,
    provider: user.app_metadata?.provider,
    otpType,
    flow: code ? "pkce" : "otp",
  });

  // Recuperação de senha nunca passa pelo onboarding: a conta já existe e o
  // objetivo do link é abrir o formulário de nova senha.
  if (otpType === "recovery") {
    return redirectToPath(request, RECOVERY_PATH);
  }

  // Sucesso: sempre a porta única, com 307. `/painel` × `/completar-cadastro`
  // é decidido no middleware, consultando `establishments` — nunca aqui.
  return redirectToPath(request, POST_AUTH_PATH);
}
