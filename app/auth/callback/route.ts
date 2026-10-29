import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/** Destino padrão de links de recuperação de senha. */
const DEFAULT_RECOVERY_NEXT = "/nova-senha";
/** Destino padrão dos links de confirmação de e-mail: o painel. */
const DEFAULT_CONFIRMATION_NEXT = "/painel";

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
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  const otpType = isEmailOtpType(type) ? type : null;
  const fallbackNext =
    otpType === "recovery" ? DEFAULT_RECOVERY_NEXT : DEFAULT_CONFIRMATION_NEXT;
  const next = safeNextPath(searchParams.get("next"), fallbackNext);

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  } else if (tokenHash && otpType) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    });
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
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
