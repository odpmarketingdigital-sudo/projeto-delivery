"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

/** Validação simples de e-mail (mesmo padrão usado no cadastro). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const INPUT_CLASS =
  "w-full rounded-xl border border-gray-700 bg-gray-800/60 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 transition focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400";

interface ForgotPasswordDialogProps {
  /** Fecha o diálogo (fundo, botão X, "Cancelar" ou "Entendi"). */
  onClose: () => void;
  /** E-mail já digitado no login, usado para pré-preencher o campo. */
  defaultEmail?: string;
}

/**
 * Modal de recuperação de senha da tela de login.
 *
 * Envia o e-mail de redefinição pelo Supabase Auth. O link aponta para
 * `/auth/callback?next=/nova-senha`: o callback troca o código pela sessão de
 * recuperação e só então libera a tela `/nova-senha` para definir a senha.
 *
 * Por segurança, o Supabase não informa se o e-mail existe — a confirmação é
 * sempre genérica ("se existir uma conta com este e-mail...").
 */
export function ForgotPasswordDialog({
  onClose,
  defaultEmail = "",
}: ForgotPasswordDialogProps) {
  const supabase = createClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState(defaultEmail.trim());
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  /** E-mail para o qual o link foi enviado (null = ainda no formulário). */
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Foco inicial no campo e fechamento pelo teclado (Esc).
  useEffect(() => {
    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSending) return;

    const cleanEmail = email.trim();

    if (!EMAIL_PATTERN.test(cleanEmail)) {
      setError("Informe um e-mail válido.");
      return;
    }

    setError(null);
    setIsSending(true);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      cleanEmail,
      {
        redirectTo: `${window.location.origin}/auth/callback?next=/nova-senha`,
      }
    );

    setIsSending(false);

    if (resetError) {
      setError(
        resetError.status === 429
          ? "Muitas solicitações em pouco tempo. Aguarde alguns minutos e tente novamente."
          : "Não foi possível enviar o e-mail agora. Tente novamente em instantes."
      );
      return;
    }

    setSentTo(cleanEmail);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="forgot-password-title"
      className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-6"
    >
      {/* Fundo clicável para fechar */}
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div className="relative w-full max-w-md rounded-t-3xl border border-gray-800 bg-gray-900 p-6 shadow-2xl sm:rounded-3xl sm:p-7">
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="absolute right-4 top-4 rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 6l12 12M18 6L6 18"
            />
          </svg>
        </button>

        {sentTo ? (
          <div className="pt-2 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-2xl text-emerald-400">
              ✉️
            </span>
            <h2
              id="forgot-password-title"
              className="mt-4 text-lg font-bold text-white"
            >
              E-mail enviado!
            </h2>
            <p className="mt-2 text-sm text-gray-400">
              Se existir uma conta cadastrada com{" "}
              <span className="font-semibold text-gray-200">{sentTo}</span>,
              enviamos um link para você criar uma nova senha.
            </p>
            <p className="mt-3 rounded-xl border border-gray-800 bg-gray-800/40 px-3 py-2.5 text-xs text-gray-400">
              O link expira em 60 minutos e pode levar alguns instantes para
              chegar. Não encontrou? Verifique a caixa de spam ou lixo
              eletrônico.
            </p>

            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex w-full items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200"
              >
                Entendi
              </button>
              <button
                type="button"
                onClick={() => {
                  setSentTo(null);
                  setError(null);
                }}
                className="inline-flex w-full items-center justify-center rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:border-gray-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
              >
                Reenviar para outro e-mail
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-5 pr-8">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-yellow-400/15 text-xl">
                🔑
              </span>
              <h2
                id="forgot-password-title"
                className="mt-3 text-lg font-bold text-white"
              >
                Recuperar senha
              </h2>
              <p className="mt-1 text-sm text-gray-400">
                Informe o e-mail cadastrado e enviaremos um link para você criar
                uma nova senha.
              </p>
            </div>

            <form
              onSubmit={handleSubmit}
              noValidate
              className="flex flex-col gap-4"
            >
              <div>
                <label
                  htmlFor="forgot-email"
                  className="mb-1.5 block text-sm font-semibold text-gray-200"
                >
                  E-mail
                </label>
                <input
                  ref={inputRef}
                  id="forgot-email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="seu@email.com"
                  className={INPUT_CLASS}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "forgot-email-error" : undefined}
                />
              </div>

              {error && (
                <p
                  id="forgot-email-error"
                  role="alert"
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-400"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={isSending}
                className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-3 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
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
                ) : (
                  "Enviar link de recuperação"
                )}
              </button>

              <button
                type="button"
                onClick={onClose}
                className="inline-flex w-full items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold text-gray-400 transition hover:text-white focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
              >
                Cancelar
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
