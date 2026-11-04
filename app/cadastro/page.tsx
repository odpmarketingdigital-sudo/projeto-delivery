"use client";

import {
  Suspense,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { GoogleAuthButton } from "@/app/components/GoogleAuthButton";
import {
  MIN_PASSWORD_LENGTH,
  emailError,
  passwordError,
} from "@/lib/registration";
import { createClient } from "@/lib/supabase/client";
import { TRIAL_DAYS } from "@/lib/subscriptions";

/**
 * Cadastro público (`/cadastro`) — **etapa 1: o acesso**.
 *
 * O fluxo do Ipepper é autenticação primeiro, loja depois:
 *
 *  1. **aqui** — o usuário escolhe como entrar (Google ou e-mail + senha);
 *  2. **`/auth/callback`** (Google) ou **`/auth/continuar`** (depois do
 *     `signInWithPassword` deste formulário) — o servidor consulta
 *     `establishments` e decide: conta com loja vai para `/painel`, conta sem
 *     loja vai para `/completar-cadastro`;
 *  3. **`/completar-cadastro`** — nome da loja, CPF/CNPJ, WhatsApp e link do
 *     cardápio, já vinculados ao `user_id` da sessão.
 *
 * Por que nesta ordem: o vínculo da loja vem da sessão autenticada, nunca de um
 * rascunho no navegador. Não existe mais cookie temporário de cadastro, então
 * bloquear cookies, trocar de aba ou abrir o link do Google em outro navegador
 * não deixa a conta "sem estabelecimento".
 */

/** Campos do formulário (mesmos nomes aceitos por `POST /api/signup`). */
type Field = "email" | "password";

type Errors = Partial<Record<Field, string>>;

/** Ordem usada para focar o primeiro campo inválido. */
const FIELD_ORDER: Field[] = ["email", "password"];

/**
 * Decisão pós-login, tomada no servidor (`lib/supabase/middleware.ts`, rota
 * `/auth/continuar`): `/painel` para quem tem loja, `/completar-cadastro` para
 * quem não tem.
 */
const POST_AUTH_PATH = "/auth/continuar";

const INPUT_BASE =
  "w-full rounded-xl border bg-[#0d0f12] px-3.5 py-2.5 text-sm text-white placeholder-gray-500 transition focus:outline-none focus:ring-1";
const INPUT_OK =
  "border-white/10 focus:border-amber-400 focus:ring-amber-400";
const INPUT_ERROR =
  "border-red-500/70 focus:border-red-400 focus:ring-red-400";

/**
 * Falhas do Google devolvidas em `?erro=` por `/auth/callback`.
 *
 * `access_denied` é o cancelamento na tela do provedor; qualquer outro código
 * cai na mensagem genérica.
 */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied:
    "O login com o Google foi cancelado. Tente de novo ou crie a conta com e-mail e senha.",
};

const OAUTH_FALLBACK_MESSAGE =
  "Não foi possível concluir o login com o Google. Tente novamente ou use e-mail e senha.";

/**
 * Validação local com as MESMAS regras da API (`lib/registration.ts`).
 * O servidor revalida — esta checagem serve para dar feedback imediato.
 */
function validate(email: string, password: string): Errors {
  const errors: Errors = {};

  const emailMessage = emailError(email);
  if (emailMessage) errors.email = emailMessage;

  const passwordMessage = passwordError(password);
  if (passwordMessage) errors.password = passwordMessage;

  return errors;
}

/** Rótulo + input + mensagem de erro/hint (padrão visual do card). */
function FieldShell({
  htmlFor,
  label,
  hint,
  error,
  children,
}: {
  htmlFor: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-400"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p
          id={`${htmlFor}-error`}
          role="alert"
          className="mt-1.5 text-xs font-medium text-red-400"
        >
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1.5 text-xs text-gray-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Resposta de `POST /api/signup`. */
interface SignupResponse {
  error?: string;
  field?: string;
  /** `email_exists` quando o e-mail já tem conta (HTTP 409). */
  code?: string;
  email_confirmation_required?: boolean;
}

function SignupView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** E-mail de conta criada, mas ainda não confirmada (atalho de reenvio). */
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  /** Falha devolvida pelo Google em `?erro=` (cancelamento, etc.). */
  const oauthErrorCode = searchParams.get("erro");
  const oauthMessage = oauthErrorCode
    ? (OAUTH_ERROR_MESSAGES[oauthErrorCode] ?? OAUTH_FALLBACK_MESSAGE)
    : null;

  const updateField = (field: Field, value: string) => {
    if (field === "email") setEmail(value);
    else setPassword(value);

    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  /**
   * Entra com e-mail + senha e segue para `/auth/continuar`.
   *
   * A decisão entre `/painel` e `/completar-cadastro` é do **servidor**, que
   * consulta `establishments` pelo `user_id` da sessão — `user_metadata` não é
   * fonte confiável (pode estar desatualizado e levar conta sem loja ao painel).
   */
  const signInAndRedirect = async (): Promise<
    "done" | "unconfirmed" | "failed"
  > => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error || !data.user) {
      return error?.code === "email_not_confirmed" ? "unconfirmed" : "failed";
    }

    router.replace(POST_AUTH_PATH);
    router.refresh();

    return "done";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);
    setUnconfirmedEmail(null);

    const nextErrors = validate(email, password);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      const first = FIELD_ORDER.find((field) => nextErrors[field]);
      if (first) document.getElementById(first)?.focus();
      return;
    }

    setErrors({});
    setIsSubmitting(true);

    const normalizedEmail = email.trim().toLowerCase();

    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, password }),
      });

      const payload = (await response
        .json()
        .catch(() => ({}))) as SignupResponse;

      if (response.ok) {
        // Conta pendente de confirmação: NADA de login automático.
        if (payload.email_confirmation_required) {
          router.replace(
            `/confirmar-email?email=${encodeURIComponent(normalizedEmail)}`
          );
          return;
        }

        // Projeto sem confirmação obrigatória: login automático (cookies) e
        // seguimos para a etapa da loja.
        const result = await signInAndRedirect();

        if (result === "done") return;

        setIsSubmitting(false);

        if (result === "unconfirmed") {
          setUnconfirmedEmail(normalizedEmail);
          setFormError("Confirme o seu e-mail para continuar.");
          return;
        }

        setFormError(
          "Sua conta foi criada! Entre com o e-mail e a senha para continuar."
        );
        return;
      }

      /**
       * E-mail já cadastrado: em vez de um beco sem saída, tentamos entrar com
       * a senha digitada. A tela funciona como cadastro **ou** login — quem já
       * é cliente cai no painel (ou no onboarding) sem trocar de página.
       */
      if (response.status === 409 && payload.code === "email_exists") {
        const result = await signInAndRedirect();

        if (result === "done") return;

        setIsSubmitting(false);

        if (result === "unconfirmed") {
          setUnconfirmedEmail(normalizedEmail);
          setFormError(
            "Este e-mail já tem conta, mas o endereço ainda não foi confirmado."
          );
          return;
        }

        setErrors({ password: "Confira a senha desta conta." });
        setFormError(
          "Este e-mail já tem conta. Informe a senha correta ou use o login."
        );
        return;
      }

      const field =
        payload.field === "email" || payload.field === "password"
          ? payload.field
          : null;

      if (field) {
        setErrors({
          [field]: payload.error ?? "Verifique este campo e tente novamente.",
        });
        document.getElementById(field)?.focus();
      } else {
        setFormError(
          payload.error ?? "Não foi possível criar sua conta. Tente novamente."
        );
      }

      setIsSubmitting(false);
    } catch {
      setFormError(
        "Falha de conexão. Verifique sua internet e tente novamente."
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0d0f12] text-white">
      {/* Brilhos decorativos (tema Fuego) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_45%_at_15%_0%,rgba(251,191,36,0.16),transparent_65%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_40%_at_100%_100%,rgba(249,115,22,0.12),transparent_70%)]"
      />

      <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_520px] lg:gap-16 lg:px-8 lg:py-16">
        {/* Coluna de marca (desktop) */}
        <aside className="hidden lg:block">
          <Link
            href="/"
            aria-label="Voltar para a página inicial do Ipepper"
            className="inline-flex rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-4 focus-visible:ring-offset-[#0d0f12]"
          >
            <Image
              src="/logotipo.svg"
              alt="Ipepper"
              width={323}
              height={150}
              preload
              unoptimized
              className="h-10 w-auto"
            />
          </Link>

          <h1 className="mt-10 text-balance text-4xl font-black leading-[1.05] tracking-[-0.03em]">
            Seu cardápio digital no ar em minutos, vendendo pelo{" "}
            <span className="bg-gradient-to-r from-amber-300 via-amber-400 to-orange-400 bg-clip-text text-transparent">
              WhatsApp
            </span>
            .
          </h1>

          <p className="mt-5 max-w-md text-sm leading-relaxed text-gray-400">
            Crie seu acesso agora e cadastre os dados da loja no passo seguinte.
            O link do seu cardápio fica pronto assim que você terminar.
          </p>

          <ul className="mt-8 space-y-3 text-sm text-gray-300">
            {[
              `${TRIAL_DAYS} dias grátis, sem cartão de crédito`,
              "Pedidos organizados no painel e no WhatsApp",
              "Link próprio para divulgar no Instagram e no Google",
              "Cardápio, preços e horários sob o seu controle",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-[10px] font-black text-amber-300"
                >
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>
        </aside>

        <div>
          {/* Topo enxuto no mobile */}
          <div className="mb-6 flex items-center justify-between lg:hidden">
            <Link
              href="/"
              aria-label="Voltar para a página inicial do Ipepper"
              className="inline-flex rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <Image
                src="/logotipo.svg"
                alt="Ipepper"
                width={323}
                height={150}
                preload
                unoptimized
                className="h-8 w-auto"
              />
            </Link>
            <Link
              href="/login"
              className="rounded-lg px-2 py-1 text-xs font-semibold text-gray-400 transition hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              Entrar
            </Link>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#161920] p-6 shadow-2xl shadow-black/50 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-xl font-black tracking-tight text-white">
                  Crie seu acesso
                </h2>
                <p className="mt-1 text-sm text-gray-400">
                  Entre com o Google ou crie uma senha. Os dados da loja ficam
                  para o passo seguinte.
                </p>
              </div>
              <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-300">
                Etapa 1 de 2
              </span>
            </div>

            {/* Trilha das etapas: acesso → loja (ordem invertida em relação ao
                fluxo antigo, que começava pelos dados da loja). */}
            <div className="mt-5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em]">
              <span aria-current="step" className="text-amber-300">
                Seu acesso
              </span>
              <span aria-hidden className="h-px w-4 bg-white/15" />
              <span className="text-gray-500">Sua loja</span>
            </div>

            {oauthMessage && (
              <div
                role="alert"
                className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-xs font-medium text-red-300"
              >
                {oauthMessage}
              </div>
            )}

            <div className="mt-5">
              <GoogleAuthButton label="Continuar com Google" />
            </div>

            <div className="mt-5 flex items-center gap-3">
              <span aria-hidden className="h-px flex-1 bg-white/10" />
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
                ou com e-mail e senha
              </span>
              <span aria-hidden className="h-px flex-1 bg-white/10" />
            </div>

            <form noValidate onSubmit={handleSubmit} className="mt-5 space-y-5">
              <FieldShell htmlFor="email" label="E-mail" error={errors.email}>
                <input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => updateField("email", event.target.value)}
                  placeholder="voce@seurestaurante.com"
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  className={`${INPUT_BASE} ${errors.email ? INPUT_ERROR : INPUT_OK}`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="password"
                label="Senha"
                hint={`Ao menos ${MIN_PASSWORD_LENGTH} caracteres. Ela será usada para acessar o painel.`}
                error={errors.password}
              >
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) =>
                      updateField("password", event.target.value)
                    }
                    placeholder="••••••••"
                    aria-invalid={Boolean(errors.password)}
                    aria-describedby={
                      errors.password ? "password-error" : "password-hint"
                    }
                    className={`${INPUT_BASE} ${errors.password ? INPUT_ERROR : INPUT_OK} pr-20`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={
                      showPassword ? "Ocultar senha" : "Mostrar senha"
                    }
                    className="absolute inset-y-0 right-2 my-1 rounded-lg px-2.5 text-xs font-semibold text-gray-400 transition hover:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                  >
                    {showPassword ? "Ocultar" : "Mostrar"}
                  </button>
                </div>
              </FieldShell>

              {formError && (
                <p
                  role="alert"
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-300"
                >
                  {formError}
                </p>
              )}

              {unconfirmedEmail && (
                <Link
                  href={`/confirmar-email?email=${encodeURIComponent(unconfirmedEmail)}`}
                  className="inline-flex w-full items-center justify-center rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 text-sm font-semibold text-amber-300 transition hover:bg-amber-400/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
                >
                  Reenviar e-mail de confirmação
                </Link>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 px-4 py-3 text-sm font-black text-[#0d0f12] transition hover:from-amber-300 hover:to-orange-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? (
                  <>
                    <span
                      aria-hidden
                      className="h-4 w-4 animate-spin rounded-full border-2 border-[#0d0f12]/30 border-t-[#0d0f12]"
                    />
                    Preparando seu acesso...
                  </>
                ) : (
                  "Criar minha conta"
                )}
              </button>

              <p className="text-center text-[11px] leading-relaxed text-gray-500">
                Ao criar a conta você concorda com os{" "}
                <Link
                  href="/termos"
                  className="font-semibold text-gray-400 underline underline-offset-2 transition hover:text-amber-300"
                >
                  Termos de uso
                </Link>{" "}
                e a{" "}
                <Link
                  href="/privacidade"
                  className="font-semibold text-gray-400 underline underline-offset-2 transition hover:text-amber-300"
                >
                  Política de privacidade
                </Link>
                .
              </p>
            </form>
          </div>

          <p className="mt-5 text-center text-sm text-gray-400">
            Já tem uma conta?{" "}
            <Link
              href="/login"
              className="font-semibold text-amber-300 underline underline-offset-2 transition hover:text-amber-200"
            >
              Entrar
            </Link>
          </p>

          <p className="mt-3 text-center text-xs text-gray-500">
            <Link
              href="/"
              className="font-medium text-gray-500 transition hover:text-amber-300"
            >
              ← Voltar ao site
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Rota `/cadastro`.
 *
 * `SignupView` usa `useSearchParams()` para exibir o erro devolvido por
 * `/auth/callback`, então precisa de um `<Suspense>`: com isso a página segue
 * estática e apenas a árvore do formulário é renderizada no cliente.
 */
export default function CadastroPage() {
  return (
    <Suspense
      fallback={
        <div
          aria-busy="true"
          aria-label="Carregando formulário de cadastro"
          className="min-h-screen bg-[#0d0f12]"
        />
      }
    >
      <SignupView />
    </Suspense>
  );
}
