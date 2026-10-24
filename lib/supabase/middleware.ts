import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Renova a sessão do Supabase a cada requisição e protege as rotas do
 * painel no nível do middleware.
 *
 * - Sem sessão, qualquer rota /painel* é redirecionada para /login.
 * - Com sessão, /login e /cadastro redirecionam para /painel.
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

  // Rotas do painel exigem sessão ativa.
  if (isPainelRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  // Usuário já autenticado não precisa ver login/cadastro.
  if (isAuthEntryRoute && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/painel";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
