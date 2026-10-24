import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Destino padrão do callback: a tela de criação de nova senha.
 * Usado quando `?next=` está ausente ou aponta para fora do site.
 */
const DEFAULT_NEXT = "/nova-senha";

/**
 * Só aceita caminhos internos (evita open redirect).
 *
 * Rejeita URLs absolutas (`https://...`) e URLs protocol-relative (`//evil`).
 */
function safeNextPath(value: string | null): string {
  if (!value) return DEFAULT_NEXT;
  if (!value.startsWith("/")) return DEFAULT_NEXT;
  if (value.startsWith("//")) return DEFAULT_NEXT;
  return value;
}

/**
 * GET /auth/callback
 *
 * Rota de retorno dos links enviados por e-mail (recuperação de senha).
 * Troca o código/token pela sessão do Supabase e redireciona para `next`
 * (por padrão `/nova-senha`).
 *
 * Dois formatos são aceitos:
 *  - `?code=...` → fluxo PKCE usado pelo cliente do `@supabase/ssr`
 *    (`resetPasswordForEmail` guarda o *code verifier* em cookie);
 *  - `?token_hash=...&type=recovery` → fluxo por OTP, útil quando o link é
 *    aberto em outro navegador/dispositivo (sem o cookie do verifier).
 *
 * Em caso de falha, volta para `next` com `?erro=link-invalido` para que a
 * tela `/nova-senha` exiba uma mensagem amigável e ofereça um novo link.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNextPath(searchParams.get("next"));

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  } else if (tokenHash && type === "recovery") {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  const failureUrl = new URL(next, origin);
  failureUrl.searchParams.set("erro", "link-invalido");

  return NextResponse.redirect(failureUrl);
}
