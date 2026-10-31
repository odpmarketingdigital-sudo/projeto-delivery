"use client";

import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { GoogleAuthButton } from "@/app/components/GoogleAuthButton";
import {
  isCnpjSituacaoAtiva,
  isValidCnpj,
  lookupCnpj,
  type CnpjInfo,
} from "@/lib/cnpj";
import {
  DOCUMENT_PLACEHOLDERS,
  DOCUMENT_TYPE_LABELS,
  MAX_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  MIN_PASSWORD_LENGTH,
  SLUG_PREFIX,
  emailError,
  formatDocumentInput,
  formatWhatsappInput,
  onlyDigits,
  ownerNameError,
  passwordError,
  validateEstablishmentDraft,
  type DocumentType,
  type EstablishmentDraft,
} from "@/lib/registration";
import { createClient } from "@/lib/supabase/client";
import { slugify } from "@/lib/slug";
import { TRIAL_DAYS } from "@/lib/subscriptions";

/** Campos do formulário (mesmos nomes aceitos por POST /api/signup). */
type Field =
  | "owner_name"
  | "email"
  | "password"
  | "establishment_name"
  | "document_type"
  | "document_number"
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
  "document_type",
  "document_number",
  "phone",
  "slug",
];

const EMPTY_FORM: FormState = {
  owner_name: "",
  email: "",
  password: "",
  establishment_name: "",
  document_type: "cpf",
  document_number: "",
  phone: "",
  slug: "",
};

/**
 * Estado da consulta de CNPJ na BrasilAPI (só existe quando o tipo é `cnpj`).
 *
 * - `idle`    → nada a consultar (CPF, número incompleto ou inválido);
 * - `loading` → requisição em andamento;
 * - `done`    → resposta recebida (`info.situacao` pode ser `null` quando a API
 *               responde em um formato não reconhecido);
 * - `error`   → consulta não concluída (`not_found` = CNPJ inexistente).
 */
type CnpjCheck =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; info: CnpjInfo }
  | { state: "error"; reason: "not_found" | "unavailable" };

/**
 * Último resultado guardado, sempre identificado pelo CNPJ consultado.
 *
 * Guardar o número junto do resultado permite **derivar** o estado exibido no
 * render: enquanto o resultado não corresponde ao CNPJ atual, a consulta está
 * em andamento — sem `setState` no corpo do efeito (evita renders em cascata).
 */
type CnpjLookupState =
  | { cnpj: string; info: CnpjInfo }
  | { cnpj: string; reason: "not_found" | "unavailable" };

/** Combina o CNPJ atual com o último resultado para montar o estado da UI. */
function resolveCnpjCheck(
  digits: string,
  ready: boolean,
  result: CnpjLookupState | null
): CnpjCheck {
  if (!ready) return { state: "idle" };
  if (!result || result.cnpj !== digits) return { state: "loading" };
  if ("info" in result) return { state: "done", info: result.info };
  return { state: "error", reason: result.reason };
}

/** Espera após o último dígito antes de chamar a API (evita 1 request/dígito). */
const CNPJ_LOOKUP_DEBOUNCE_MS = 450;

/** Aviso amigável para situação cadastral diferente de `ATIVA`. */
function cnpjInactiveMessage(situacao: string): string {
  return `Este CNPJ não está apto para o cadastro: na Receita Federal consta como ${situacao}. Confira o número digitado ou use outro CNPJ.`;
}

interface CnpjNotice {
  tone: "info" | "success" | "warning" | "error";
  message: string;
}

/** Cores dos avisos da consulta (mesma paleta escura do card). */
const CNPJ_NOTICE_TONES: Record<CnpjNotice["tone"], string> = {
  info: "border-white/10 bg-white/[0.04] text-gray-400",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  error: "border-red-500/40 bg-red-500/10 text-red-300",
};

/**
 * Traduz o estado da consulta no aviso exibido abaixo do campo.
 *
 * Indisponibilidade da BrasilAPI nunca vira bloqueio: o aviso é só informativo
 * (o cadastro segue normalmente).
 */
function describeCnpjCheck(check: CnpjCheck): CnpjNotice | null {
  switch (check.state) {
    case "loading":
      return {
        tone: "info",
        message: "Consultando o CNPJ na Receita Federal…",
      };

    case "error":
      return check.reason === "not_found"
        ? {
            tone: "warning",
            message:
              "CNPJ não encontrado na Receita Federal. Confira o número digitado.",
          }
        : {
            tone: "warning",
            message:
              "Não foi possível consultar o CNPJ agora. Você pode continuar o cadastro.",
          };

    case "done": {
      const { info } = check;

      if (!info.situacao) {
        return {
          tone: "warning",
          message:
            "Encontramos o CNPJ, mas não foi possível confirmar a situação cadastral. Você pode continuar o cadastro.",
        };
      }

      if (!isCnpjSituacaoAtiva(info.situacao)) {
        return { tone: "error", message: cnpjInactiveMessage(info.situacao) };
      }

      const label = info.nomeFantasia ?? info.razaoSocial;

      return {
        tone: "success",
        message: label
          ? `CNPJ ativo na Receita Federal — ${label}.`
          : "CNPJ ativo na Receita Federal.",
      };
    }

    default:
      return null;
  }
}

/**
 * Destino único depois de autenticar em `/cadastro`.
 *
 * O cadastro manual (`POST /api/signup`) já cria a loja, então o painel é o
 * destino final. Quem entra pelo Google sem loja passa antes por
 * `/completar-cadastro` — decidido em `/auth/callback` — e essa tela também
 * conclui em `/painel`. Ou seja: qualquer caminho de sucesso termina no painel.
 */
const POST_AUTH_REDIRECT = "/painel";

/**
 * Converte o campo devolvido pela API no nome usado no formulário.
 *
 * A rota responde com os nomes do contrato (`name`, `whatsapp`), enquanto a
 * tela mantém `establishment_name` e `phone` (compatibilidade com o layout).
 */
function toFormField(field: string): Field | null {
  if (field === "name") return "establishment_name";
  if (field === "whatsapp") return "phone";
  return (FIELD_ORDER as string[]).includes(field) ? (field as Field) : null;
}

const INPUT_BASE =
  "w-full rounded-xl border bg-[#0d0f12] px-3.5 py-2.5 text-sm text-white placeholder-gray-500 transition focus:outline-none focus:ring-1";
const INPUT_OK = "border-white/10 focus:border-amber-400 focus:ring-amber-400";
const INPUT_ERROR =
  "border-red-500/70 focus:border-red-400 focus:ring-red-400";
const LABEL_CLASS =
  "mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400";

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
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Validação local com as MESMAS regras da API (`lib/registration.ts`).
 * O servidor revalida tudo — esta checagem só dá feedback imediato.
 */
function validate(form: FormState): Errors {
  const errors: Errors = {};

  const ownerMessage = ownerNameError(form.owner_name);
  if (ownerMessage) errors.owner_name = ownerMessage;

  const emailMessage = emailError(form.email);
  if (emailMessage) errors.email = emailMessage;

  const passwordMessage = passwordError(form.password);
  if (passwordMessage) errors.password = passwordMessage;

  const draft: EstablishmentDraft = {
    name: form.establishment_name,
    document_type: form.document_type === "cnpj" ? "cnpj" : "cpf",
    document_number: form.document_number,
    /** O formulário chama de `phone`, mas o contrato salva como WhatsApp. */
    whatsapp: form.phone,
    slug: form.slug,
  };

  const draftErrors = validateEstablishmentDraft(draft);

  if (draftErrors.name) errors.establishment_name = draftErrors.name;
  if (draftErrors.document_type) errors.document_type = draftErrors.document_type;
  if (draftErrors.document_number)
    errors.document_number = draftErrors.document_number;
  if (draftErrors.whatsapp) errors.phone = draftErrors.whatsapp;
  if (draftErrors.slug) errors.slug = draftErrors.slug;

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
      <label htmlFor={htmlFor} className={LABEL_CLASS}>
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

const OAUTH_ERROR_MESSAGE =
  "Não foi possível concluir o login com o Google. Tente novamente ou crie a conta com e-mail e senha.";

/**
 * Cadastro público (`/cadastro`) — onboarding self-service.
 *
 * Fluxo:
 *  1. Valida no cliente com as mesmas regras de `POST /api/signup`
 *     (`lib/registration.ts`), incluindo CPF/CNPJ, WhatsApp e slug.
 *     Para CNPJ, consulta a situação cadastral na BrasilAPI (`lib/cnpj.ts`) e
 *     bloqueia o envio quando a Receita não retorna `ATIVA`.
 *  2. A rota cria a conta (`auth.users`), o `profiles` (role `admin`) e a loja
 *     em `public.establishments` já em trial, via service role.
 *  3. `email_confirmation_required` → `/confirmar-email` (sem sessão).
 *  4. Caso contrário faz login automático e abre `/painel`.
 *
 * O botão "Continuar com Google" usa OAuth do Supabase: o retorno passa por
 * `/auth/callback`, que manda contas sem loja para `/completar-cadastro`.
 */
function SignupView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Enquanto o usuário não editar o link manualmente, ele acompanha o nome.
  const [slugTouched, setSlugTouched] = useState(false);
  // Some com o aviso assim que o usuário tenta enviar o formulário de novo.
  const [oauthErrorDismissed, setOauthErrorDismissed] = useState(false);
  // Resultado da consulta de CNPJ na BrasilAPI (só quando o tipo é `cnpj`).
  const [cnpjResult, setCnpjResult] = useState<CnpjLookupState | null>(null);
  /**
   * Espelho de `slugTouched` para o preenchimento automático vindo da Receita:
   * evita que o efeito de consulta dependa do estado e refaça a request a cada
   * edição do link do cardápio.
   */
  const slugTouchedRef = useRef(false);

  const slugPreview = slugify(form.slug || form.establishment_name);

  const cnpjDigits =
    form.document_type === "cnpj" ? onlyDigits(form.document_number) : "";
  const cnpjReady = isValidCnpj(cnpjDigits);

  /**
   * Consulta automática da situação cadastral quando o CNPJ fica completo.
   *
   * - debounce curto: o usuário digita 14 dígitos e só a versão final é enviada;
   * - `AbortController` descarta respostas de números já alterados;
   * - `not_found`/`unavailable` viram apenas avisos (não bloqueiam o cadastro);
   * - o nome do estabelecimento só é preenchido se o campo estiver vazio
   *   (nunca sobrescreve o que o usuário digitou).
   */
  useEffect(() => {
    if (!cnpjReady) return;

    const controller = new AbortController();

    const timer = setTimeout(() => {
      void lookupCnpj(cnpjDigits, { signal: controller.signal }).then(
        (result) => {
          if (controller.signal.aborted) return;

          setCnpjResult(
            result.ok
              ? { cnpj: cnpjDigits, info: result.info }
              : {
                  cnpj: cnpjDigits,
                  reason:
                    result.reason === "not_found"
                      ? "not_found"
                      : "unavailable",
                }
          );

          if (!result.ok) return;

          const suggestion = (
            result.info.nomeFantasia ?? result.info.razaoSocial
          )
            ?.trim()
            .slice(0, MAX_NAME_LENGTH);

          if (!suggestion) return;

          setForm((prev) => {
            if (prev.establishment_name.trim()) return prev;

            return {
              ...prev,
              establishment_name: suggestion,
              slug: slugTouchedRef.current
                ? prev.slug
                : slugify(suggestion).slice(0, MAX_SLUG_LENGTH),
            };
          });

          setErrors((prev) => {
            if (!prev.establishment_name && !prev.slug) return prev;

            const next = { ...prev };
            delete next.establishment_name;
            if (!slugTouchedRef.current) delete next.slug;
            return next;
          });
        }
      );
    }, CNPJ_LOOKUP_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cnpjDigits, cnpjReady]);

  // Enquanto o resultado guardado não é do CNPJ atual, o aviso é "consultando".
  const cnpjCheck = resolveCnpjCheck(cnpjDigits, cnpjReady, cnpjResult);

  /**
   * `/auth/callback` volta com `?erro=...` quando o Google falha ou o usuário
   * cancela no provedor. Derivado do `useSearchParams` (sem efeito/estado
   * espelhado), dentro do `<Suspense>` abaixo.
   */
  const oauthError =
    !oauthErrorDismissed && searchParams.get("erro")
      ? OAUTH_ERROR_MESSAGE
      : null;
  const visibleError = formError ?? oauthError;

  const cnpjNotice = describeCnpjCheck(cnpjCheck);
  /** CNPJ com situação conhecida e diferente de ATIVA → cadastro bloqueado. */
  const cnpjBlocked =
    cnpjCheck.state === "done" &&
    cnpjCheck.info.situacao !== null &&
    !isCnpjSituacaoAtiva(cnpjCheck.info.situacao);
  const documentHasError =
    Boolean(errors.document_type ?? errors.document_number) || cnpjBlocked;
  const documentDescribedBy = [
    errors.document_type ?? errors.document_number
      ? "document_number-error"
      : "document_number-hint",
    cnpjNotice ? "document_number-cnpj-status" : null,
  ]
    .filter(Boolean)
    .join(" ");

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
      slug: slugTouched ? prev.slug : slugify(value).slice(0, MAX_SLUG_LENGTH),
    }));
    clearError("establishment_name");
    if (!slugTouched) clearError("slug");
  };

  const handleSlugChange = (value: string) => {
    slugTouchedRef.current = true;
    setSlugTouched(true);
    setForm((prev) => ({ ...prev, slug: sanitizeSlugInput(value) }));
    clearError("slug");
  };

  /** Troca CPF ⇄ CNPJ reaplicando a máscara no mesmo número. */
  const handleDocumentTypeChange = (type: DocumentType) => {
    setForm((prev) => ({
      ...prev,
      document_type: type,
      document_number: formatDocumentInput(prev.document_number, type),
    }));
    clearError("document_type");
    clearError("document_number");
  };

  /**
   * Última checagem antes do `POST /api/signup`.
   *
   * Cobre o caso em que o usuário cola o CNPJ e envia o formulário antes da
   * consulta automática terminar. Só bloqueia quando a BrasilAPI responde com
   * uma situação conhecida diferente de `ATIVA` — falha de rede, timeout ou
   * resposta fora do formato não impedem o cadastro.
   */
  const verifyCnpjBeforeSubmit = async (): Promise<string | null> => {
    if (form.document_type !== "cnpj" || !isValidCnpj(form.document_number)) {
      return null;
    }

    if (cnpjCheck.state === "done") {
      const { situacao } = cnpjCheck.info;

      return situacao && !isCnpjSituacaoAtiva(situacao)
        ? cnpjInactiveMessage(situacao)
        : null;
    }

    const result = await lookupCnpj(form.document_number);
    if (!result.ok) return null;

    setCnpjResult({
      cnpj: onlyDigits(form.document_number),
      info: result.info,
    });

    const { situacao } = result.info;

    return situacao && !isCnpjSituacaoAtiva(situacao)
      ? cnpjInactiveMessage(situacao)
      : null;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const nextErrors = validate(form);
    setErrors(nextErrors);
    setFormError(null);
    setOauthErrorDismissed(true);

    if (Object.keys(nextErrors).length > 0) {
      const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field]);
      if (firstInvalid) document.getElementById(firstInvalid)?.focus();
      return;
    }

    setIsSubmitting(true);

    // CNPJ com situação cadastral diferente de ATIVA não conclui o cadastro.
    // O aviso vermelho abaixo do campo (derivado de `cnpjBlocked`) já explica o
    // motivo, então não duplicamos a mensagem no erro do campo.
    const cnpjProblem = await verifyCnpjBeforeSubmit();
    if (cnpjProblem) {
      setIsSubmitting(false);
      document.getElementById("document_number")?.focus();
      return;
    }

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
          document_type: form.document_type === "cnpj" ? "cnpj" : "cpf",
          document_number: form.document_number,
          whatsapp: form.phone.trim(),
          slug,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        field?: string;
        /** `true` quando o Supabase exige a confirmação do e-mail antes do login. */
        email_confirmation_required?: boolean;
      };

      if (!response.ok) {
        const field = payload.field ? toFormField(payload.field) : null;

        if (field) {
          const fieldError: Errors = {};
          fieldError[field] =
            payload.error ?? "Verifique este campo e tente novamente.";
          setErrors(fieldError);
          document.getElementById(field)?.focus();
        } else {
          setFormError(
            payload.error ?? "Não foi possível criar sua conta. Tente novamente."
          );
        }
        setIsSubmitting(false);
        return;
      }

      // E-mail pendente de confirmação: NADA de login automático.
      if (payload.email_confirmation_required) {
        setIsSubmitting(false);
        router.replace(`/confirmar-email?email=${encodeURIComponent(email)}`);
        return;
      }

      // Projeto sem confirmação obrigatória: login automático (cookies) e
      // abertura do painel.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: form.password,
      });

      if (signInError) {
        setFormError("Sua conta foi criada! Faça login para acessar o painel.");
        setIsSubmitting(false);
        return;
      }

      router.replace(POST_AUTH_REDIRECT);
      router.refresh();
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
            Crie sua loja, cadastre produtos e receba pedidos organizados. O link
            do seu cardápio fica pronto assim que você terminar o cadastro.
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

            <div className="mt-6">
              <GoogleAuthButton />
              <div className="mt-4 flex items-center gap-3">
                <span aria-hidden className="h-px flex-1 bg-white/10" />
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500">
                  ou com e-mail
                </span>
                <span aria-hidden className="h-px flex-1 bg-white/10" />
              </div>
            </div>

            <form
              noValidate
              onSubmit={handleSubmit}
              className="mt-5 space-y-5"
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

              <FieldShell htmlFor="email" label="E-mail" error={errors.email}>
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
                hint={`Ao menos ${MIN_PASSWORD_LENGTH} caracteres. Ela será usada para acessar o painel.`}
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
                  placeholder="Ex.: La Fuego Burger"
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
                htmlFor="document_number"
                label="CPF ou CNPJ do responsável"
                hint="Usamos o documento apenas para emitir a nota fiscal da assinatura."
                error={errors.document_type ?? errors.document_number}
              >
                <div
                  id="document_type"
                  role="radiogroup"
                  aria-label="Tipo de documento"
                  tabIndex={-1}
                  className="mb-2 flex gap-2"
                >
                  {(Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]).map(
                    (type) => {
                      const active =
                        (form.document_type === "cnpj" ? "cnpj" : "cpf") ===
                        type;

                      return (
                        <button
                          key={type}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => handleDocumentTypeChange(type)}
                          className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold uppercase tracking-[0.08em] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 ${
                            active
                              ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
                              : "border-white/10 bg-[#0d0f12] text-gray-400 hover:border-gray-600 hover:text-gray-200"
                          }`}
                        >
                          {DOCUMENT_TYPE_LABELS[type]}
                        </button>
                      );
                    }
                  )}
                </div>

                <input
                  id="document_number"
                  name="document_number"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={form.document_number}
                  onChange={(e) =>
                    updateField(
                      "document_number",
                      formatDocumentInput(
                        e.target.value,
                        form.document_type === "cnpj" ? "cnpj" : "cpf"
                      )
                    )
                  }
                  placeholder={
                    DOCUMENT_PLACEHOLDERS[
                      form.document_type === "cnpj" ? "cnpj" : "cpf"
                    ]
                  }
                  aria-invalid={documentHasError}
                  aria-describedby={documentDescribedBy}
                  className={`${INPUT_BASE} ${
                    documentHasError ? INPUT_ERROR : INPUT_OK
                  }`}
                />

                {cnpjNotice ? (
                  <p
                    id="document_number-cnpj-status"
                    role={cnpjNotice.tone === "error" ? "alert" : "status"}
                    className={`mt-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                      CNPJ_NOTICE_TONES[cnpjNotice.tone]
                    }`}
                  >
                    {cnpjNotice.message}
                  </p>
                ) : null}
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
                    updateField("phone", formatWhatsappInput(e.target.value))
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
                hint={
                  slugPreview
                    ? `Seu cardápio ficará em ${SLUG_PREFIX}${slugPreview}`
                    : "Escolha um endereço curto e fácil de divulgar."
                }
                error={errors.slug}
              >
                <div
                  className={`flex items-stretch overflow-hidden rounded-xl border bg-[#0d0f12] transition focus-within:ring-1 ${
                    errors.slug
                      ? "border-red-500/70 focus-within:border-red-400 focus-within:ring-red-400"
                      : "border-white/10 focus-within:border-amber-400 focus-within:ring-amber-400"
                  }`}
                >
                  <span className="flex select-none items-center border-r border-white/10 px-3 text-sm text-gray-500">
                    {SLUG_PREFIX}
                  </span>
                  <input
                    id="slug"
                    name="slug"
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={form.slug}
                    onChange={(e) => handleSlugChange(e.target.value)}
                    onBlur={() =>
                      setForm((prev) => ({
                        ...prev,
                        slug: slugify(prev.slug || prev.establishment_name),
                      }))
                    }
                    maxLength={MAX_SLUG_LENGTH}
                    placeholder="minha-loja"
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={errors.slug ? "slug-error" : "slug-hint"}
                    className="w-full bg-transparent px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none"
                  />
                </div>
              </FieldShell>

              {visibleError ? (
                <div
                  role="alert"
                  className="rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-xs font-medium text-red-300"
                >
                  {visibleError}{" "}
                  <Link
                    href="/login"
                    className="font-semibold text-amber-300 underline underline-offset-2 hover:text-amber-200"
                  >
                    Ir para o login
                  </Link>
                </div>
              ) : null}

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
                    Criando sua loja...
                  </>
                ) : (
                  "Criar conta e abrir minha loja"
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






