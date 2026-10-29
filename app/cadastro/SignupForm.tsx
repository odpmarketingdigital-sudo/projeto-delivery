"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { slugify } from "@/lib/slug";
import { TRIAL_DAYS } from "@/lib/subscriptions";

/** Campos do formulário (mesmos nomes aceitos por POST /api/signup). */
type Field =
  | "owner_name"
  | "email"
  | "password"
  | "establishment_name"
  | "phone"
  | "slug";

type FormState = Record<Field, string>;
type Errors = Partial<Record<Field, string>>;

/** Ordem usada para focar o primeiro campo inválido. */
const FIELD_ORDER: Field[] = [
  "owner_name",
  "email",
  "password",
  "establishment_name",
  "phone",
  "slug",
];

const EMPTY_FORM: FormState = {
  owner_name: "",
  email: "",
  password: "",
  establishment_name: "",
  phone: "",
  slug: "",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 6;

const INPUT_BASE =
  "w-full rounded-xl border bg-gray-900/70 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 transition focus:outline-none focus:ring-1";
const INPUT_OK =
  "border-gray-700 focus:border-amber-400 focus:ring-amber-400";
const INPUT_ERROR =
  "border-red-500/70 focus:border-red-400 focus:ring-red-400";

/** Aplica a máscara `(XX) XXXXX-XXXX` enquanto o usuário digita. */
function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length === 0) return "";
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10)
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

/**
 * Normaliza o slug enquanto o usuário digita (sem remover o hífen final, para
 * não atrapalhar a digitação de "meu-restaurante"). O valor final é limpo com
 * `slugify` no envio.
 */
function sanitizeSlugInput(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}

/** Validação espelhada na rota `/api/signup`. */
function validate(form: FormState): Errors {
  const errors: Errors = {};

  if (form.owner_name.trim().length < 2) {
    errors.owner_name = "Informe o nome do responsável.";
  }

  if (!EMAIL_PATTERN.test(form.email.trim())) {
    errors.email = "Informe um e-mail válido.";
  }

  if (form.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use ao menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }

  if (form.establishment_name.trim().length < 2) {
    errors.establishment_name = "Informe o nome do restaurante.";
  }

  const phoneDigits = form.phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    errors.phone = "Informe o WhatsApp com DDD (10 ou 11 dígitos).";
  }

  if (slugify(form.slug || form.establishment_name).length < 3) {
    errors.slug = "Escolha um link com ao menos 3 caracteres.";
  }

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
        className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400"
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

/**
 * Formulário de cadastro público (`/cadastro`).
 *
 * Fluxo:
 *  1. Valida tudo no cliente (mesmas regras de `POST /api/signup`).
 *  2. Envia os dados para a rota de API, que cria a conta no Supabase Auth e o
 *     estabelecimento já em trial (30 dias).
 *  3. Se a rota indicar `email_confirmation_required`, NÃO faz login: envia o
 *     usuário para `/confirmar-email`, onde ele pode reenviar o e-mail de
 *     confirmação e só então acessar o painel.
 *  4. Em projetos sem confirmação obrigatória, faz o login automático
 *     (`signInWithPassword`) para gravar a sessão nos cookies e abre `/painel`.
 */
export function SignupForm() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Enquanto o usuário não editar o link manualmente, ele acompanha o nome.
  const [slugTouched, setSlugTouched] = useState(false);

  const slugPreview = slugify(form.slug || form.establishment_name);

  const clearError = (field: Field) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const updateField = (field: Field, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    clearError(field);
  };

  const handleEstablishmentNameChange = (value: string) => {
    setForm((prev) => ({
      ...prev,
      establishment_name: value,
      slug: slugTouched ? prev.slug : slugify(value).slice(0, 60),
    }));
    clearError("establishment_name");
    if (!slugTouched) clearError("slug");
  };

  const handleSlugChange = (value: string) => {
    setSlugTouched(true);
    setForm((prev) => ({ ...prev, slug: sanitizeSlugInput(value) }));
    clearError("slug");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const nextErrors = validate(form);
    setErrors(nextErrors);
    setFormError(null);

    if (Object.keys(nextErrors).length > 0) {
      const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field]);
      if (firstInvalid) {
        document.getElementById(firstInvalid)?.focus();
      }
      return;
    }

    setIsSubmitting(true);

    const email = form.email.trim();
    const slug = slugify(form.slug || form.establishment_name);

    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_name: form.owner_name.trim(),
          email,
          password: form.password,
          establishment_name: form.establishment_name.trim(),
          phone: form.phone.trim(),
          slug,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        field?: Field;
        /** `true` quando o Supabase exige a confirmação do e-mail antes do login. */
        email_confirmation_required?: boolean;
      };

      if (!response.ok) {
        if (payload.field) {
          const fieldError: Errors = {};
          fieldError[payload.field] =
            payload.error ?? "Verifique este campo e tente novamente.";
          setErrors(fieldError);
          document.getElementById(payload.field)?.focus();
        } else {
          setFormError(
            payload.error ?? "Não foi possível criar sua conta. Tente novamente."
          );
        }
        setIsSubmitting(false);
        return;
      }

      // E-mail pendente de confirmação: NADA de login automático.
      // O usuário vai para a tela que explica o passo e oferece o reenvio.
      if (payload.email_confirmation_required) {
        setIsSubmitting(false);
        router.replace(`/confirmar-email?email=${encodeURIComponent(email)}`);
        return;
      }

      // Projeto sem confirmação obrigatória: login automático (sessão nos
      // cookies) e abertura do painel.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: form.password,
      });

      if (signInError) {
        setFormError("Sua conta foi criada! Faça login para acessar o painel.");
        setIsSubmitting(false);
        return;
      }

      router.replace("/painel");
      router.refresh();
    } catch {
      setFormError(
        "Falha de conexão. Verifique sua internet e tente novamente."
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07090c] text-white">
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
            className="inline-flex rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-4 focus-visible:ring-offset-[#07090c]"
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

          <p className="mt-5 max-w-md text-pretty text-sm leading-relaxed text-gray-400">
            Crie a conta, cadastre os primeiros produtos e compartilhe o link do
            seu cardápio. Sem comissão por pedido e sem aplicativo para
            instalar.
          </p>

          <ul className="mt-8 space-y-4 text-sm">
            {[
              [
                `${TRIAL_DAYS} dias grátis`,
                "Teste todos os recursos sem cartão de crédito.",
              ],
              [
                "0% de comissão",
                "Cada pedido é 100% seu, direto no seu WhatsApp.",
              ],
              [
                "Pronto para vender",
                "Cardápio, checkout e painel de pedidos inclusos.",
              ],
            ].map(([title, description]) => (
              <li key={title} className="flex gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-[11px] font-black text-amber-300"
                >
                  ✓
                </span>
                <span>
                  <strong className="block font-semibold text-white">
                    {title}
                  </strong>
                  <span className="text-gray-400">{description}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-8 text-xs text-gray-500">
            Já usa o Ipepper?{" "}
            <Link
              href="/login"
              className="font-semibold text-gray-300 underline decoration-gray-600 underline-offset-2 transition hover:text-amber-300"
            >
              Acessar o painel
            </Link>
          </p>
        </aside>

        {/* Cartão do formulário */}
        <div className="w-full">
          {/* Marca (mobile) */}
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

          <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-xl font-black tracking-tight text-white">
                  Criar minha conta
                </h2>
                <p className="mt-1 text-sm text-gray-400">
                  {TRIAL_DAYS} dias grátis, sem cartão de crédito.
                </p>
              </div>
              <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-300">
                Trial
              </span>
            </div>

            <form
              noValidate
              onSubmit={handleSubmit}
              className="mt-6 space-y-5"
            >
              <FieldShell
                htmlFor="owner_name"
                label="Nome do responsável"
                error={errors.owner_name}
              >
                <input
                  id="owner_name"
                  name="owner_name"
                  type="text"
                  autoComplete="name"
                  value={form.owner_name}
                  onChange={(e) => updateField("owner_name", e.target.value)}
                  placeholder="Ex.: Maria Silva"
                  aria-invalid={Boolean(errors.owner_name)}
                  aria-describedby={
                    errors.owner_name ? "owner_name-error" : undefined
                  }
                  className={`${INPUT_BASE} ${
                    errors.owner_name ? INPUT_ERROR : INPUT_OK
                  }`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="email"
                label="E-mail"
                error={errors.email}
              >
                <input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => updateField("email", e.target.value)}
                  placeholder="voce@seurestaurante.com"
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  className={`${INPUT_BASE} ${
                    errors.email ? INPUT_ERROR : INPUT_OK
                  }`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="password"
                label="Senha"
                hint="Ao menos 6 caracteres. Ela será usada para acessar o painel."
                error={errors.password}
              >
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => updateField("password", e.target.value)}
                    placeholder="••••••••"
                    aria-invalid={Boolean(errors.password)}
                    aria-describedby={
                      errors.password ? "password-error" : "password-hint"
                    }
                    className={`${INPUT_BASE} ${
                      errors.password ? INPUT_ERROR : INPUT_OK
                    } pr-20`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    className="absolute inset-y-0 right-2 my-1 rounded-lg px-2.5 text-xs font-semibold text-gray-400 transition hover:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                  >
                    {showPassword ? "Ocultar" : "Mostrar"}
                  </button>
                </div>
              </FieldShell>

              <FieldShell
                htmlFor="establishment_name"
                label="Nome do estabelecimento"
                error={errors.establishment_name}
              >
                <input
                  id="establishment_name"
                  name="establishment_name"
                  type="text"
                  autoComplete="organization"
                  value={form.establishment_name}
                  onChange={(e) =>
                    handleEstablishmentNameChange(e.target.value)
                  }
                  placeholder="Ex.: Pizzaria do Bairro"
                  aria-invalid={Boolean(errors.establishment_name)}
                  aria-describedby={
                    errors.establishment_name
                      ? "establishment_name-error"
                      : undefined
                  }
                  className={`${INPUT_BASE} ${
                    errors.establishment_name ? INPUT_ERROR : INPUT_OK
                  }`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="phone"
                label="WhatsApp de contato"
                hint="É o número que seus clientes usam para falar com a loja."
                error={errors.phone}
              >
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={form.phone}
                  onChange={(e) =>
                    updateField("phone", formatPhone(e.target.value))
                  }
                  placeholder="(11) 99999-9999"
                  aria-invalid={Boolean(errors.phone)}
                  aria-describedby={errors.phone ? "phone-error" : "phone-hint"}
                  className={`${INPUT_BASE} ${
                    errors.phone ? INPUT_ERROR : INPUT_OK
                  }`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="slug"
                label="Link do cardápio"
                hint="É o endereço que você compartilha no WhatsApp e nas redes."
                error={errors.slug}
              >
                <div
                  className={`flex items-stretch overflow-hidden rounded-xl border bg-gray-900/70 transition focus-within:ring-1 ${
                    errors.slug
                      ? "border-red-500/70 focus-within:border-red-400 focus-within:ring-red-400"
                      : "border-gray-700 focus-within:border-amber-400 focus-within:ring-amber-400"
                  }`}
                >
                  <span className="flex shrink-0 items-center border-r border-gray-700/70 px-3 text-xs font-medium text-gray-500">
                    ipepper.com.br/
                  </span>
                  <input
                    id="slug"
                    name="slug"
                    type="text"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={form.slug}
                    onChange={(e) => handleSlugChange(e.target.value)}
                    onBlur={() =>
                      setForm((prev) => ({
                        ...prev,
                        slug: slugify(prev.slug),
                      }))
                    }
                    placeholder="meu-restaurante"
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={errors.slug ? "slug-error" : "slug-hint"}
                    className="w-full bg-transparent px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none"
                  />
                </div>
              </FieldShell>

              {slugPreview && !errors.slug ? (
                <p className="-mt-2 truncate text-xs text-gray-500">
                  Seu cardápio ficará em{" "}
                  <span className="font-semibold text-amber-300">
                    /{slugPreview}
                  </span>
                </p>
              ) : null}

              {formError && (
                <p
                  role="alert"
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-300"
                >
                  {formError}
                </p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 text-sm font-black text-gray-950 shadow-lg shadow-amber-500/25 transition hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-[#07090c] disabled:cursor-not-allowed disabled:opacity-70"
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
                    Criando sua conta...
                  </>
                ) : (
                  "Criar conta grátis"
                )}
              </button>

              <p className="text-center text-xs text-gray-500">
                {TRIAL_DAYS} dias grátis · Sem cartão de crédito · Cancele
                quando quiser
              </p>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-gray-500">
            Já tem uma conta?{" "}
            <Link
              href="/login"
              className="font-semibold text-gray-300 underline decoration-gray-600 underline-offset-2 transition hover:text-amber-300"
            >
              Acessar o painel
            </Link>
            {" · "}
            <Link
              href="/"
              className="font-semibold text-gray-300 underline decoration-gray-600 underline-offset-2 transition hover:text-amber-300"
            >
              Voltar ao site
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
