"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/** Regras mínimas da senha (espelham o mínimo aceito pelo Supabase Auth). */
const MIN_PASSWORD_LENGTH = 6;
/** bcrypt ignora bytes acima de 72 — evita erro silencioso no Supabase. */
const MAX_PASSWORD_LENGTH = 72;
/** Tempo entre o sucesso e o redirecionamento automático para o painel. */
const REDIRECT_DELAY_MS = 2500;

const INPUT_CLASS =
  "w-full rounded-xl border border-gray-700 bg-gray-800/60 px-3.5 py-2.5 pr-20 text-sm text-white placeholder-gray-500 transition focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Situação da tela:
 * - `checking`: verificando se existe sessão de recuperação;
 * - `ready`: sessão válida, pode digitar a nova senha;
 * - `missing`: link inválido/expirado (ou acesso direto sem link);
 * - `done`: senha atualizada com sucesso.
 */
type FormStatus = "checking" | "ready" | "missing" | "done";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
  disabled?: boolean;
}

/** Campo de senha com botão "Mostrar/Ocultar" (mesmo padrão da tela de login). */
function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  disabled,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-sm font-semibold text-gray-200"
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="••••••••"
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          disabled={disabled}
          className={INPUT_CLASS}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute inset-y-0 right-2 my-1 rounded-lg px-2.5 text-xs font-semibold text-gray-400 transition hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
          aria-label={visible ? `Ocultar ${label}` : `Mostrar ${label}`}
        >
          {visible ? "Ocultar" : "Mostrar"}
        </button>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-gray-500">
          {hint}
        </p>
      )}
    </div>
  );
}

interface ResetPasswordFormProps {
  /** True quando o callback informou `?erro=link-invalido`. */
  linkError?: boolean;
}

/**
 * Formulário público de criação de nova senha (`/nova-senha`).
 *
 * O acesso acontece pelo link do e-mail: `/auth/callback` troca o código pela
 * sessão de recuperação e redireciona para cá. Sem essa sessão a tela mostra
 * um aviso amigável e o caminho para pedir um novo link — evitando que o
 * usuário preencha o formulário para receber um erro no envio.
 */
export function ResetPasswordForm({
  linkError = false,
}: ResetPasswordFormProps) {
  const supabase = createClient();
  const router = useRouter();

  const [status, setStatus] = useState<FormStatus>(
    linkError ? "missing" : "checking"
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Confirma se a sessão de recuperação está ativa (criada pelo callback).
  useEffect(() => {
    if (linkError) return;

    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setStatus((current) => {
        if (current === "done") return current;
        return data.session ? "ready" : "missing";
      });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active || !session) return;
      setStatus((current) => (current === "checking" ? "ready" : current));
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase, linkError]);

  // Após o sucesso, leva o usuário ao painel (o guard cuida do super_admin).
  useEffect(() => {
    if (status !== "done") return;

    const timer = setTimeout(() => {
      router.replace("/painel");
      router.refresh();
    }, REDIRECT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [status, router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        `A nova senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`
      );
      return;
    }

    if (password !== confirmation) {
      setError("As senhas não coincidem. Digite a mesma senha nos dois campos.");
      return;
    }

    setIsSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setIsSubmitting(false);

    if (updateError) {
      // 401/403 = a sessão de recuperação não existe mais (link expirado).
      if (updateError.status === 401 || updateError.status === 403) {
        setStatus("missing");
        setError(
          "Sua sessão de recuperação expirou. Solicite um novo link para redefinir a senha."
        );
        return;
      }

      if (/different from the old password/i.test(updateError.message)) {
        setError("A nova senha precisa ser diferente da senha atual.");
        return;
      }

      setError(
        "Não foi possível salvar a nova senha agora. Tente novamente em instantes."
      );
      return;
    }

    setPassword("");
    setConfirmation("");
    setStatus("done");
  };

  const goToPanel = () => {
    router.replace("/painel");
    router.refresh();
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gray-950 px-4 py-10">
      {/* Brilho decorativo de fundo (tema Fuego) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(250,204,21,0.12),transparent_70%)]"
      />

      <div className="relative w-full max-w-md">
        {/* Marca */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-yellow-400 to-amber-500 text-2xl font-bold text-gray-950 shadow-lg shadow-yellow-400/20">
            🔥
          </span>
          <h1 className="mt-4 text-2xl font-bold text-white">
            Criar nova senha
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Escolha uma nova senha para acessar o painel.
          </p>
        </div>

        <div className="rounded-3xl border border-gray-800 bg-gray-900/80 p-6 shadow-2xl backdrop-blur-sm sm:p-8">
          {status === "checking" && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col items-center gap-3 py-6 text-center"
            >
              <svg
                aria-hidden="true"
                className="h-6 w-6 animate-spin text-yellow-400"
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
              <p className="text-sm text-gray-400">
                Validando seu link de recuperação...
              </p>
            </div>
          )}

          {status === "missing" && (
            <div className="text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-2xl text-amber-400">
                ⏳
              </span>
              <h2 className="mt-4 text-lg font-bold text-white">
                Link inválido ou expirado
              </h2>
              <p className="mt-2 text-sm text-gray-400">
                {error ??
                  (linkError
                    ? "Não foi possível validar o link de recuperação. Ele pode ter expirado ou já ter sido utilizado."
                    : "Para criar uma nova senha, abra o link que enviamos para o seu e-mail. Se ele já expirou, solicite outro.")}
              </p>
              <Link
                href="/login"
                className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200"
              >
                Pedir novo link
              </Link>
            </div>
          )}

          {status === "done" && (
            <div role="status" aria-live="polite" className="text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-2xl text-emerald-400">
                ✅
              </span>
              <h2 className="mt-4 text-lg font-bold text-white">
                Senha atualizada!
              </h2>
              <p className="mt-2 text-sm text-gray-400">
                Sua nova senha já está valendo. Estamos te levando para o
                painel...
              </p>
              <button
                type="button"
                onClick={goToPanel}
                className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200"
              >
                Ir para o painel agora
              </button>
            </div>
          )}

          {status === "ready" && (
            <form
              onSubmit={handleSubmit}
              noValidate
              className="flex flex-col gap-5"
            >
              <PasswordField
                id="new-password"
                label="Nova senha"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                hint={`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres.`}
                disabled={isSubmitting}
              />

              <PasswordField
                id="confirm-password"
                label="Confirmar nova senha"
                value={confirmation}
                onChange={setConfirmation}
                autoComplete="new-password"
                disabled={isSubmitting}
              />

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-400"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-3 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? (
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
                    Salvando...
                  </>
                ) : (
                  "Salvar nova senha"
                )}
              </button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          <Link
            href="/login"
            className="font-medium text-gray-400 transition hover:text-yellow-300"
          >
            ← Voltar para o login
          </Link>
        </p>
      </div>
    </div>
  );
}
