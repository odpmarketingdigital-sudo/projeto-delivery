import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Renova a sessão do Supabase a cada requisição e protege as rotas do
 * painel no nível do middleware.
 *
 * - Sem sessão, qualquer rota /painel* é redirecionada para /login.
 * - Com sessão, /login e /cadastro redirecionam para /painel.
 * - Sessão com e-mail pendente (`email_confirmed_at` nulo) NÃO entra no
 *   painel: é levada para `/confirmar-email`, onde pode reenviar o link de
 *   confirmação. Isso vale mesmo que o cliente consiga abrir a rota, porque a
 *   checagem acontece no servidor, com o usuário devolvido por `getUser()`.
 * - A verificação fina de role (super_admin em /painel/admin) é feita no
 *   layout do painel, que consulta a tabela `profiles`.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANTE: não coloque lógica entre createServerClient e getUser().
  // Reautenticar tokens aqui mantém a sessão viva entre abas/recarregamentos.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPainelRoute = pathname.startsWith("/painel");
  // Telas de entrada: fazem sentido apenas para quem ainda não está logado.
  const isAuthEntryRoute =
    pathname.startsWith("/login") || pathname.startsWith("/cadastro");
  // Tela de aviso + reenvio do e-mail de confirmação.
  const isConfirmEmailRoute = pathname.startsWith("/confirmar-email");

  /**
   * E-mail confirmado?
   *
   * `email_confirmed_at` é nulo enquanto a conta criada com "Confirm email"
   * ativo segue pendente. `confirmed_at` é o campo legado (mesmo valor) e
   * cobre projetos/base com o Auth em versões anteriores.
   */
  const isEmailConfirmed = Boolean(
    user?.email_confirmed_at ?? user?.confirmed_at
  );

  // Rotas do painel exigem sessão ativa.
  if (isPainelRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  // Sessão válida, mas e-mail ainda não confirmado: fora do painel.
  if (isPainelRoute && user && !isEmailConfirmed) {
    return redirectToConfirmEmail(request, user.email);
  }

  // Usuário já autenticado não precisa ver login/cadastro.
  if (isAuthEntryRoute && user) {
    if (!isEmailConfirmed) {
      return redirectToConfirmEmail(request, user.email);
    }

    const url = request.nextUrl.clone();
    url.pathname = "/painel";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Quem já confirmou o e-mail não precisa da tela de aviso.
  if (isConfirmEmailRoute && user && isEmailConfirmed) {
    const url = request.nextUrl.clone();
    url.pathname = "/painel";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

/**
 * Monta o redirect para `/confirmar-email` levando o e-mail na query (a tela
 * usa o valor para pré-preencher o botão de reenvio).
 */
function redirectToConfirmEmail(request: NextRequest, email?: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/confirmar-email";
  url.search = "";
  if (email) url.searchParams.set("email", email);
  return NextResponse.redirect(url);
}
