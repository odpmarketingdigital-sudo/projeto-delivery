"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  CONFIRMATION_RATE_LIMIT_MESSAGE,
  CONFIRMATION_RESEND_COOLDOWN_SECONDS,
} from "@/lib/supabase/confirmation";

/** Validação simples de e-mail (mesmo padrão usado no cadastro/login). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** `checking` enquanto o `getUser()` inicial não responde. */
type SessionState = "checking" | "signed-in" | "signed-out";

/** Corpo devolvido por `POST /api/auth/resend-confirmation`. */
interface ResendConfirmationResponse {
  ok?: boolean;
  message?: string;
  error?: string;
  code?: string;
  /** Segundos até poder pedir outro reenvio (200 e 429). */
  retry_after?: number;
}

interface ConfirmEmailPanelProps {
  /** E-mail recebido por `?email=` (cadastro e redirects do middleware). */
  defaultEmail?: string;
  /** `?erro=link-invalido`: o link clicado expirou ou já foi usado. */
  linkInvalid?: boolean;
}

/**
 * Tela que bloqueia o painel até a confirmação do e-mail.
 *
 * Ela é o destino de:
 *  - `POST /api/signup` quando o Supabase exige confirmação (sem sessão);
 *  - middleware/`PainelGuard` quando a sessão existe mas
 *    `email_confirmed_at` está nulo.
 *
 * Ações disponíveis:
 *  1. **Reenviar** o e-mail de confirmação via `POST /api/auth/resend-confirmation`
 *     — o envio é feito no servidor (service role), que devolve mensagens já
 *     traduzidas e trata o rate limit (429) com `retry_after`. O link recebido
 *     aponta para `/auth/callback`, que abre o painel;
 *  2. **Já confirmei**: atualiza a sessão (`refreshSession`) e tenta entrar.
 *     Sem sessão neste navegador, encaminha para o login.
 */
export function ConfirmEmailPanel({
  defaultEmail = "",
  linkInvalid = false,
}: ConfirmEmailPanelProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [email, setEmail] = useState(defaultEmail.trim());
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [error, setError] = useState<string | null>(
    linkInvalid
      ? "O link de confirmação é inválido ou expirou. Reenvie o e-mail para receber um novo."
      : null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  /** Segundos restantes até liberar novo reenvio (0 = liberado). */
  const [cooldown, setCooldown] = useState(0);

  // Contagem regressiva do cooldown devolvido pela rota (200 ou 429): mantém o
  // botão bloqueado e mostra ao usuário quanto falta, sem novo clique.
  useEffect(() => {
    if (cooldown <= 0) return;

    const timer = setTimeout(() => {
      setCooldown((previous) => (previous > 0 ? previous - 1 : 0));
    }, 1000);

    return () => clearTimeout(timer);
  }, [cooldown]);

  // Descobre se há sessão ativa e se ela já está confirmada (ex.: link aberto
  // em outra aba). O cadastro novo chega aqui SEM sessão.
  useEffect(() => {
    let active = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;

      const user = data.user;
      if (!user) {
        setSessionState("signed-out");
        return;
      }

      setSessionState("signed-in");
      const userEmail = user.email ?? "";
      if (userEmail) setEmail((prev) => prev || userEmail);

      // Confirmação concluída enquanto esta tela estava aberta.
      if (user.email_confirmed_at ?? user.confirmed_at) {
        router.replace("/painel");
        router.refresh();
      }
    });

    return () => {
      active = false;
    };
  }, [router, supabase]);

  const handleResend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSending || cooldown > 0) return;

    const cleanEmail = email.trim();
    setError(null);
    setNotice(null);

    if (!EMAIL_PATTERN.test(cleanEmail)) {
      setError("Informe o e-mail usado no cadastro.");
      return;
    }

    setIsSending(true);

    try {
      // Envio no servidor: a rota classifica o erro do GoTrue e devolve a
      // mensagem pronta — inclusive o 429 com `retry_after` em segundos.
      const response = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cleanEmail }),
      });

      const payload = (await response
        .json()
        .catch(() => null)) as ResendConfirmationResponse | null;

      const retryAfter =
        payload?.retry_after && payload.retry_after > 0
          ? payload.retry_after
          : CONFIRMATION_RESEND_COOLDOWN_SECONDS;

      if (response.ok) {
        setNotice(
          payload?.message ??
            `Enviamos um novo link de confirmação para ${cleanEmail}. Confira a caixa de entrada e o spam.`
        );
        setCooldown(retryAfter);
        return;
      }

      // 429 = rate limit do Supabase (ou cooldown local). A mensagem vem do
      // servidor: "Aguarde 1 minuto antes de solicitar um novo e-mail".
      if (response.status === 429) {
        setError(payload?.error ?? CONFIRMATION_RATE_LIMIT_MESSAGE);
        setCooldown(retryAfter);
        return;
      }

      if (response.status === 409 || payload?.code === "already_confirmed") {
        setError(
          payload?.error ??
            "Este e-mail já está confirmado. Faça login para acessar o painel."
        );
        return;
      }

      setError(
        payload?.error ??
          "Não foi possível reenviar o e-mail agora. Confira o endereço informado e tente novamente."
      );
    } catch {
      // Falha de rede/DNS: sem o `catch` o botão ficava preso em "Enviando..."
      // e nenhuma mensagem aparecia para o usuário.
      setError("Falha de conexão. Verifique sua internet e tente novamente.");
    } finally {
      setIsSending(false);
    }
  };

  const handleCheckConfirmation = async () => {
    if (isChecking) return;

    setError(null);
    setNotice(null);

    // Sem sessão neste navegador: o link do e-mail é que libera a conta; o
    // acesso ao painel acontece pelo login.
    if (sessionState === "signed-out") {
      router.push("/login");
      return;
    }

    setIsChecking(true);
    // O JWT em cache pode ter o estado antigo — busca o usuário no GoTrue.
    const { data, error: refreshError } = await supabase.auth.refreshSession();
    setIsChecking(false);

    const user = data.user;
    if (user && (user.email_confirmed_at ?? user.confirmed_at)) {
      router.replace("/painel");
      router.refresh();
      return;
    }

    setError(
      refreshError
        ? "Não foi possível verificar agora. Tente novamente em instantes."
        : "Ainda não identificamos a confirmação. Abra o link enviado ao seu e-mail e tente novamente."
    );
  };

  const inputClass =
    "w-full rounded-xl border border-gray-700 bg-gray-800/60 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 transition focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400";

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gray-950 px-4 py-10">
      {/* Brilho decorativo de fundo (tema Fuego) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(250,204,21,0.12),transparent_70%)]"
      />

      <div className="relative w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900/60 p-6 shadow-2xl shadow-black/40 sm:p-8">
        <div className="text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-yellow-400/15 text-2xl text-yellow-300">
            ✉️
          </span>
          <h1 className="mt-4 text-xl font-bold text-white">
            Confirme o seu e-mail
          </h1>
          <p className="mt-2 text-sm text-gray-400">
            Por favor, confirme o seu e-mail antes de acessar o painel. Enviamos
            um link de confirmação para o endereço usado no cadastro.
          </p>
        </div>

        <form
          onSubmit={handleResend}
          noValidate
          className="mt-6 flex flex-col gap-4"
        >
          <div>
            <label
              htmlFor="confirm-email"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              E-mail
            </label>
            <input
              id="confirm-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
              placeholder="seu@email.com"
              className={inputClass}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "confirm-email-error" : undefined}
            />
          </div>

          {error && (
            <p
              id="confirm-email-error"
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-400"
            >
              {error}
            </p>
          )}

          {notice && (
            <p
              role="status"
              className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm font-medium text-green-300"
            >
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={isSending || cooldown > 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-3 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSending ? (
              <>
                <svg
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth={4}
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                  />
                </svg>
                Enviando...
              </>
            ) : cooldown > 0 ? (
              `Aguarde ${cooldown}s para reenviar`
            ) : (
              "Reenviar e-mail de confirmação"
            )}
          </button>

          <button
            type="button"
            onClick={handleCheckConfirmation}
            disabled={isChecking || sessionState === "checking"}
            className="inline-flex w-full items-center justify-center rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:border-gray-500 hover:text-white focus:outline-none focus:ring-2 focus:ring-yellow-400/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isChecking
              ? "Verificando..."
              : sessionState === "signed-out"
                ? "Já confirmei — ir para o login"
                : "Já confirmei meu e-mail"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-gray-500">
          <Link
            href="/login"
            className="font-semibold text-gray-300 underline decoration-gray-600 underline-offset-2 transition hover:text-yellow-300"
          >
            Voltar ao login
          </Link>
          {" · "}
          <Link
            href="/"
            className="font-semibold text-gray-300 underline decoration-gray-600 underline-offset-2 transition hover:text-yellow-300"
          >
            Voltar ao site
          </Link>
        </p>
      </div>
    </div>
  );
}
