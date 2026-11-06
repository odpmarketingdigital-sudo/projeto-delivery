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

/**
 * Cookie **fatiado** do Supabase: `sb-<ref>-auth-token.0`, `.1`, `.2`…
 * `@supabase/ssr` divide o valor em pedaços de 3180 caracteres (o `auth-js`
 * grava JSON longo: tokens + objeto `user`).
 */
const SUPABASE_CHUNK_NAME = /^(sb-.+)\.(\d+)$/;

/**
 * Opções usadas para **apagar** um cookie. O `path` tem de ser o mesmo da
 * escrita feita pela lib (`/`), senão o browser mantém a cópia antiga.
 */
const REMOVE_COOKIE_OPTIONS: CookieOptions = {
  path: "/",
  sameSite: "lax",
  httpOnly: false,
  maxAge: 0,
};

/**
 * A partir daqui o header `Cookie` já ameaça o limite de 16 KB do Node — que
 * responde `431 Request Header Fields Too Large` e derruba **todas** as rotas,
 * inclusive o login (o servidor recusa a requisição antes de qualquer código).
 */
const COOKIE_HEADER_WARN_BYTES = 8 * 1024;

/** Cookie que precisa estar no `Set-Cookie` de toda resposta do middleware. */
interface StickyCookie {
  value: string;
  options?: CookieOptions;
}

/**
 * Nomes de chunks que **nunca são lidos** por `@supabase/ssr`.
 *
 * A lib junta os pedaços com `combineChunks`, que:
 *  1. devolve o cookie inteiro (sem sufixo) quando ele existe — ignorando
 *     qualquer `.N` ao lado;
 *  2. senão, lê `.0`, `.1`, … e **para no primeiro índice ausente**.
 *
 * Logo: chunk que convive com o cookie inteiro, chunk sem `.0` e chunk depois
 * de um "buraco" na sequência são lixo — sobras de escritas antigas que nunca
 * mais serão lidas, mas continuam indo no header de toda requisição.
 */
function findOrphanChunks(cookieNames: string[]): string[] {
  const present = new Set(cookieNames);
  const orphans = new Set<string>();

  for (const name of present) {
    const match = SUPABASE_CHUNK_NAME.exec(name);
    if (!match) continue;

    const [, base, rawIndex] = match;

    // Cookie inteiro ao lado de pedaços: os pedaços são ignorados na leitura.
    if (present.has(base)) {
      orphans.add(name);
      continue;
    }

    // Sem `.0` não há sessão montável a partir dos pedaços.
    if (!present.has(`${base}.0`)) {
      orphans.add(name);
      continue;
    }

    const index = Number(rawIndex);
    for (let previous = 0; previous < index; previous += 1) {
      if (!present.has(`${base}.${previous}`)) {
        orphans.add(name);
        break;
      }
    }
  }

  return [...orphans];
}

/**
 * Renova a sessão do Supabase + protege as rotas do painel (middleware raiz).
 *
 * ## Cookies (por que esta implementação difere do exemplo dos docs)
 *
 * A sessão do Supabase vive em cookies fatiados. Se pedaços antigos não forem
 * apagados, o header `Cookie` cresce a cada renovação até estourar o limite do
 * servidor e o app inteiro passa a responder `431 Request Header Fields Too
 * Large` (o browser não consegue nem carregar o login). Três cuidados evitam
 * isso:
 *
 *  1. **`setAll` acumula, não substitui.** A lib chama `setAll` mais de uma vez
 *     na mesma requisição (ex.: `-code-verifier` do PKCE e, em seguida, a
 *     sessão). Recriar a `NextResponse` a cada chamada descartaria os
 *     `Set-Cookie` anteriores — inclusive as remoções de chunks antigos
 *     (`Max-Age=0`). Por isso os cookies ficam em `stickyCookies` e são
 *     reaplicados em qualquer resposta criada depois.
 *  2. **Redirect também leva os cookies.** Se a sessão é renovada na
 *     requisição que redireciona (`/login`, `/confirmar-email`,
 *     `/auth/continuar`) e o `Set-Cookie` se perde, o browser volta com o token
 *     velho, o middleware renova outra vez… um ciclo de gravações por request.
 *  3. **Poda de chunks órfãos.** Sobras de escritas antigas (ver
 *     `findOrphanChunks`) são apagadas no browser, o que devolve o header a um
 *     tamanho saudável sem exigir limpeza manual.
 *
 * `response` é o que a função devolve no fim: a última resposta montada por
 * `continueResponse`/`redirectResponse`, sempre com os cookies pendentes.
 */
export async function updateSession(request: NextRequest) {
  /** Cookies que devem sair em **toda** resposta desta requisição. */
  const stickyCookies = new Map<string, StickyCookie>();

  /** Aplica os cookies pendentes na resposta informada. */
  const withSessionCookies = (target: NextResponse): NextResponse => {
    for (const [name, cookie] of stickyCookies) {
      const options = cookie.options;

      // Remoção: `cookies.delete()` emite `Max-Age=0; Expires=<passado>`, que o
      // browser respeita. `set(name, "", { maxAge: 0 })` também funciona, mas o
      // Next ainda acrescenta um `Set-Cookie` vazio (`name=; Path=/`) depois do
      // nosso, o que recria o cookie em vez de apagá-lo.
      if (options?.maxAge === 0) {
        target.cookies.delete({
          name,
          path: typeof options.path === "string" ? options.path : "/",
        });
        continue;
      }

      target.cookies.set(name, cookie.value, options);
    }
    return target;
  };

  /** Resposta normal (página/rota) carregando os cookies da sessão. */
  const continueResponse = (): NextResponse =>
    withSessionCookies(
      NextResponse.next({
        request: {
          headers: request.headers,
        },
      })
    );

  /** Redirect carregando os cookies da sessão (nunca descartar o refresh). */
  const redirectResponse = (url: URL): NextResponse =>
    withSessionCookies(NextResponse.redirect(url));

  // 1) Higiene antes de qualquer leitura: pedaços órfãos do cookie de sessão
  //    são agendados para remoção no browser (a lib nunca os lê).
  const orphanChunks = findOrphanChunks(
    request.cookies.getAll().map((cookie) => cookie.name)
  );

  if (orphanChunks.length > 0) {
    for (const name of orphanChunks) {
      // Só agendamos a remoção na resposta: o chunk órfão continua na request,
      // mas a lib nunca o lê (ver `findOrphanChunks`).
      stickyCookies.set(name, { value: "", options: REMOVE_COOKIE_OPTIONS });
    }

    console.warn(
      "[middleware] chunks órfãos do cookie de sessão removidos — evita o 431",
      { cookies: orphanChunks }
    );
  }

  // 2) Diagnóstico: header grande é o prenúncio do 431.
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (cookieHeader.length > COOKIE_HEADER_WARN_BYTES) {
    console.warn(
      "[middleware] header Cookie muito grande — limpe os cookies do domínio se o 431 voltar",
      {
        bytes: cookieHeader.length,
        cookies: request.cookies.getAll().length,
      }
    );
  }

  // A resposta "normal" só é criada depois da higiene: ela precisa carregar os
  // `Set-Cookie` de remoção dos chunks órfãos.
  let response = continueResponse();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            // Propaga o token renovado para os Server Components…
            request.cookies.set(name, value);
            // …e garante que ele (ou a remoção, com `maxAge: 0`) sobreviva a
            // quantas recriações de resposta acontecerem nesta requisição.
            stickyCookies.set(name, { value, options });
          });

          response = continueResponse();
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
    return decidePostAuth(request, supabase, user, redirectResponse);
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
    return redirectResponse(url);
  }

  // Onboarding com e-mail pendente: confirma antes de criar a loja.
  if (isOnboardingRoute && user && !isEmailConfirmed) {
    return redirectToConfirmEmail(request, user.email, redirectResponse);
  }

  // Rotas do painel exigem sessão ativa.
  if (isPainelRoute && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return redirectResponse(url);
  }

  // Sessão válida, mas e-mail ainda não confirmado: fora do painel.
  if (isPainelRoute && user && !isEmailConfirmed) {
    return redirectToConfirmEmail(request, user.email, redirectResponse);
  }

  // Usuário já autenticado não precisa ver login/cadastro: a decisão final
  // (`/painel` × `/completar-cadastro`) fica em `/auth/continuar`.
  if (isAuthEntryRoute && user) {
    if (!isEmailConfirmed) {
      return redirectToConfirmEmail(request, user.email, redirectResponse);
    }

    return redirectToPath(request, POST_AUTH_PATH, redirectResponse);
  }

  // Quem já confirmou o e-mail não precisa da tela de aviso.
  if (isConfirmEmailRoute && user && isEmailConfirmed) {
    return redirectToPath(request, POST_AUTH_PATH, redirectResponse);
  }

  return response;
}

/** Assinatura de resposta-redirect do middleware (leva os cookies da sessão). */
type RedirectResponse = (url: URL) => NextResponse;

/** Redirect interno preservando a origem (sem query string). */
function redirectToPath(
  request: NextRequest,
  pathname: string,
  redirect: RedirectResponse
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return redirect(url);
}

/**
 * Monta o redirect para `/confirmar-email` levando o e-mail na query (a tela
 * usa o valor para pré-preencher o botão de reenvio).
 */
function redirectToConfirmEmail(
  request: NextRequest,
  email: string | undefined,
  redirect: RedirectResponse
) {
  const url = request.nextUrl.clone();
  url.pathname = "/confirmar-email";
  url.search = "";
  if (email) url.searchParams.set("email", email);
  return redirect(url);
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
  user: User | null,
  redirect: RedirectResponse
) {
  if (!user) return redirectToPath(request, "/login", redirect);

  if (!(user.email_confirmed_at ?? user.confirmed_at)) {
    return redirectToConfirmEmail(request, user.email, redirect);
  }

  if ((await resolveRole(supabase, user)) === "super_admin") {
    console.log("[auth/continuar] super_admin — indo para o painel admin", {
      userId: user.id,
    });

    return redirectToPath(request, ADMIN_PATH, redirect);
  }

  const hasStore = await hasEstablishmentForUser(supabase, user.id);

  if (hasStore === true) {
    console.log("[auth/continuar] conta com loja — indo para o painel", {
      userId: user.id,
    });

    return redirectToPath(request, PANEL_PATH, redirect);
  }

  console.warn(
    "[auth/continuar] conta sem loja confirmada — indo para o onboarding",
    { userId: user.id, storeCheck: hasStore === null ? "falhou" : "sem loja" }
  );

  return redirectToPath(request, ONBOARDING_PATH, redirect);
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

