import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { hasEstablishmentForUser } from "@/lib/supabase/establishments";

/**
 * Renova a sessão do Supabase a cada requisição e protege as rotas do
 * painel no nível do middleware.
 *
 * - Sem sessão, qualquer rota /painel* é redirecionada para /login.
 * - Com sessão, /login, /cadastro e /confirmar-email levam a `/auth/continuar`,
 *   que consulta o banco e decide entre `/painel` (conta com loja) e
 *   `/completar-cadastro` (etapa 2 pendente).
 * - Sessão com e-mail pendente (`email_confirmed_at` nulo) NÃO entra no
 *   painel: é levada para `/confirmar-email`, onde pode reenviar o link de
 *   confirmação. Isso vale mesmo que o cliente consiga abrir a rota, porque a
 *   checagem acontece no servidor, com o usuário devolvido por `getUser()`.
 * - A verificação fina de role (super_admin em /painel/admin) é feita no
 *   layout do painel, que consulta a tabela `profiles`.
 */
/**
 * Decisão pós-autenticação: consulta `establishments` e escolhe entre painel e
 * onboarding (ver `decidePostAuth`).
 *
 * O middleware NÃO decide pelo `user_metadata.onboarding_complete`: metadata
 * pode estar desatualizada e mandaria conta sem loja para o painel.
 */
const POST_AUTH_PATH = "/auth/continuar";

/** Conta com loja cadastrada. */
const PANEL_PATH = "/painel";
/** Painel administrativo (super_admin não tem estabelecimento). */
const ADMIN_PATH = "/painel/admin";
/** Conta autenticada que ainda precisa criar a loja (etapa 2). */
const ONBOARDING_PATH = "/completar-cadastro";

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

  /**
   * `/auth/continuar` — porta única de decisão pós-login. Resolvida aqui para
   * responder com um **redirect HTTP real** (307), sem renderizar página: vale
   * para `router.replace("/auth/continuar")` e para acesso direto, sem depender
   * de JavaScript para sair da tela.
   */
  if (pathname === POST_AUTH_PATH) {
    return decidePostAuth(request, supabase, user);
  }

  const isPainelRoute = pathname.startsWith("/painel");
  // Telas de entrada: fazem sentido apenas para quem ainda não está logado.
  const isAuthEntryRoute =
    pathname.startsWith("/login") || pathname.startsWith("/cadastro");
  // Tela de aviso + reenvio do e-mail de confirmação.
  const isConfirmEmailRoute = pathname.startsWith("/confirmar-email");
  // Onboarding obrigatório (etapa 2 do cadastro): dados do estabelecimento.
  const isOnboardingRoute = pathname.startsWith("/completar-cadastro");

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

  // Onboarding exige sessão ativa (o fluxo normal vem do /auth/callback).
  if (isOnboardingRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("redirect", "/completar-cadastro");
    return NextResponse.redirect(url);
  }

  // Onboarding com e-mail pendente: confirma antes de criar a loja.
  if (isOnboardingRoute && user && !isEmailConfirmed) {
    return redirectToConfirmEmail(request, user.email);
  }

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

  // Usuário já autenticado não precisa ver login/cadastro: a decisão final
  // (`/painel` × `/completar-cadastro`) fica em `/auth/continuar`.
  if (isAuthEntryRoute && user) {
    if (!isEmailConfirmed) {
      return redirectToConfirmEmail(request, user.email);
    }

    return redirectToPath(request, POST_AUTH_PATH);
  }

  // Quem já confirmou o e-mail não precisa da tela de aviso.
  if (isConfirmEmailRoute && user && isEmailConfirmed) {
    return redirectToPath(request, POST_AUTH_PATH);
  }

  return response;
}

/** Redirect interno preservando a origem (sem query string). */
function redirectToPath(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url);
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

/**
 * Decisão pós-autenticação (rota `/auth/continuar`).
 *
 * Fonte da verdade: `establishments` consultado com o cliente da sessão (RLS
 * `establishments_select_own`), nunca `user_metadata.onboarding_complete` —
 * metadata desatualizada mandava conta sem loja para o painel.
 *
 *  1. sem sessão → `/login`;
 *  2. e-mail pendente → `/confirmar-email`;
 *  3. `super_admin` → `/painel/admin`;
 *  4. tem loja → `/painel`;
 *  5. sem loja (ou consulta falhou) → `/completar-cadastro`
 *     (que reconsulta o banco e devolve ao painel se a loja existir).
 */
async function decidePostAuth(
  request: NextRequest,
  supabase: SupabaseClient,
  user: User | null
) {
  if (!user) return redirectToPath(request, "/login");

  if (!(user.email_confirmed_at ?? user.confirmed_at)) {
    return redirectToConfirmEmail(request, user.email);
  }

  if ((await resolveRole(supabase, user)) === "super_admin") {
    console.log("[auth/continuar] super_admin — indo para o painel admin", {
      userId: user.id,
    });

    return redirectToPath(request, ADMIN_PATH);
  }

  const hasStore = await hasEstablishmentForUser(supabase, user.id);

  if (hasStore === true) {
    console.log("[auth/continuar] conta com loja — indo para o painel", {
      userId: user.id,
    });

    return redirectToPath(request, PANEL_PATH);
  }

  console.warn(
    "[auth/continuar] conta sem loja confirmada — indo para o onboarding",
    { userId: user.id, storeCheck: hasStore === null ? "falhou" : "sem loja" }
  );

  return redirectToPath(request, ONBOARDING_PATH);
}

/**
 * Papel do usuário (`profiles.role`), com o JWT como atalho.
 *
 * `null` quando não deu para ler — tratamos como conta comum, que é o caminho
 * seguro (um super_admin sempre tem a linha em `profiles`).
 */
async function resolveRole(
  supabase: SupabaseClient,
  user: User
): Promise<string | null> {
  const fromMetadata = user.user_metadata?.role;

  if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
    return fromMetadata;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.warn("[auth/continuar] falha ao ler o perfil", {
      userId: user.id,
      code: error.code,
    });
    return null;
  }

  const role = (data as { role?: string | null } | null)?.role;
  return typeof role === "string" && role.length > 0 ? role : null;
}

