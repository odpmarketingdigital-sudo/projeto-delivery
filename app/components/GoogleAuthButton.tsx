"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const BASE_CLASS =
  "inline-flex w-full items-center justify-center gap-2.5 rounded-xl border px-4 py-3 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:cursor-not-allowed disabled:opacity-70";

const THEMES = {
  /** Fundo escuro (cards de `/cadastro` e `/login`). */
  dark: "border-gray-700 bg-gray-900/70 text-white hover:border-gray-500 hover:bg-gray-800",
} as const;

/** Logo oficial do Google (multicolorido) — decorativo. */
function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-4 w-4 shrink-0">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19Z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
      />
    </svg>
  );
}

/**
 * Destino padrão pós-OAuth (Google): o painel.
 *
 * É o mesmo fallback usado por `/auth/callback` quando `next` não vem na URL.
 */
const DEFAULT_POST_AUTH_NEXT = "/painel";

/**
 * Só aceita caminhos internos (`/painel`, `/painel/produtos`...).
 *
 * Um `next` externo (`https://...`, `//evil.com`) seria um open redirect;
 * nesses casos voltamos ao padrão `/painel`. O `/auth/callback` revalida o
 * valor no servidor antes de redirecionar.
 */
function normalizePostAuthNext(next: string): string {
  const trimmed = next.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return DEFAULT_POST_AUTH_NEXT;
  }
  return trimmed;
}

/**
 * Caminho da Route Handler que troca o `code` pela sessão (e cria a loja a
 * partir do rascunho). A URL de retorno é SEMPRE `origin + este caminho`.
 */
const AUTH_CALLBACK_PATH = "/auth/callback";

/**
 * URLs absolutas de retorno do OAuth.
 *
 * O Supabase exige `redirectTo` absoluto e o compara com a lista de *Redirect
 * URLs* do projeto, por isso o caminho é montado de forma explícita
 * (`${origin}/auth/callback`) em vez de concatenar string na mão. `next` vai
 * como query e é revalidado no servidor antes de qualquer redirect.
 */
function buildRedirectTo(next: string): string {
  const url = new URL(`${window.location.origin}${AUTH_CALLBACK_PATH}`);
  url.searchParams.set("next", normalizePostAuthNext(next));
  return url.toString();
}

/**
 * Botão "Continuar com Google" (OAuth pelo Supabase Auth).
 *
 * Quem trata o retorno é `app/auth/callback/route.ts`, que troca o `code` pela
 * sessão e decide o destino:
 *  - usuário novo vindo de `/cadastro` **com rascunho da loja** → a loja é criada
 *    ali mesmo (`lib/signupDraft.ts`) e o usuário abre o `/painel`;
 *  - conta **sem** estabelecimento e sem rascunho → `/completar-cadastro`, onde
 *    o usuário informa loja, CPF/CNPJ, WhatsApp e link do cardápio (a tela
 *    conclui em `/painel`);
 *  - conta **com** estabelecimento → `next` (padrão `/painel`).
 *
 * O callback nunca manda para o painel uma conta sem loja **confirmada** — é
 * por isso que `next` só é usado quando `establishments` devolve a linha.
 *
 * `redirectTo` precisa ser absoluto, então o `origin` é lido apenas no clique
 * (dentro do handler) — assim não há divergência entre SSR e hidratação.
 */
export function GoogleAuthButton({
  next = DEFAULT_POST_AUTH_NEXT,
  label = "Continuar com Google",
  theme = "dark",
  className = "",
  beforeRedirect,
}: {
  /** Destino pós-OAuth quando a conta já tem estabelecimento (padrão `/painel`). */
  next?: string;
  label?: string;
  theme?: keyof typeof THEMES;
  className?: string;
  /**
   * Gancho executado antes de sair da página.
   *
   * `/cadastro` usa para validar os dados do estabelecimento e gravá-los no
   * `sessionStorage`/cookie do rascunho. Devolver `false` (ou lançar erro)
   * cancela o redirect e mantém o usuário no formulário.
   */
  beforeRedirect?: () => boolean | Promise<boolean>;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (isLoading) return;

    setError(null);
    setIsLoading(true);

    if (beforeRedirect) {
      let allowed = true;

      try {
        allowed = (await beforeRedirect()) !== false;
      } catch {
        allowed = false;
        setError(
          "Não foi possível preparar o cadastro da sua loja. Tente novamente."
        );
      }

      // Validação reprovada: o formulário já mostra os erros por campo.
      if (!allowed) {
        setIsLoading(false);
        return;
      }
    }

    /**
     * O rascunho (quando existe, em `/cadastro`) já está gravado neste ponto:
     * `beforeRedirect` acima é aguardado antes de sair da página. Montamos a URL
     * de retorno explicitamente e só então chamamos o Supabase — nada de
     * navegação antes da gravação do cookie.
     */
    const redirectTo = buildRedirectTo(next);

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        // Sempre deixa o usuário escolher a conta (evita entrar na errada).
        queryParams: { prompt: "select_account" },
      },
    });

    if (oauthError) {
      setError("Não foi possível abrir o login do Google. Tente novamente.");
      setIsLoading(false);
      return;
    }

    // Sucesso = o navegador está indo para o Google. Mantemos `isLoading` para
    // bloquear cliques repetidos durante a transição de página.
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={handleClick}
        disabled={isLoading}
        aria-busy={isLoading}
        className={`${BASE_CLASS} ${THEMES[theme]}`}
      >
        <GoogleIcon />
        {isLoading ? "Abrindo o Google..." : label}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
