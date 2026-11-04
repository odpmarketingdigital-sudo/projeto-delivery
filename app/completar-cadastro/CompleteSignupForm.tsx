"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CNPJ_SITUACAO_ATIVA, lookupCnpj, type CnpjInfo } from "@/lib/cnpj";
import {
  DOCUMENT_PLACEHOLDERS,
  DOCUMENT_TYPE_LABELS,
  MAX_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  formatDocumentInput,
  formatWhatsappInput,
  normalizeEstablishmentDraft,
  onlyDigits,
  ownerNameError,
  validateEstablishmentDraft,
  type DocumentType,
  type EstablishmentDraft,
} from "@/lib/registration";
import { createClient } from "@/lib/supabase/client";
import { slugify } from "@/lib/slug";
import { TRIAL_DAYS } from "@/lib/subscriptions";

/** Campos do formulário (espelham o que `POST /api/signup/establishment` aceita). */
type Field =
  | "owner_name"
  | "establishment_name"
  | "document_type"
  | "document_number"
  | "whatsapp"
  | "slug";

interface FormState {
  owner_name: string;
  establishment_name: string;
  document_type: DocumentType;
  document_number: string;
  whatsapp: string;
  slug: string;
}

type Errors = Partial<Record<Field, string>>;

/**
 * Estado da consulta de CNPJ na BrasilAPI (`lib/cnpj.ts`).
 *
 * - `idle`        → nada a consultar (CPF escolhido, poucos dígitos ou CNPJ inválido);
 * - `loading`     → consulta em andamento;
 * - `active`      → empresa ATIVA na Receita (libera o cadastro);
 * - `inactive`    → BAIXADA/INAPTA/SUSPENSA/NULA (bloqueia o cadastro);
 * - `not_found`   → a Receita não tem esse CNPJ (bloqueia o cadastro);
 * - `unavailable` → BrasilAPI fora do ar/timeout: apenas avisa, não bloqueia.
 */
type CnpjCheck =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "active"; info: CnpjInfo }
  | { status: "inactive"; info: CnpjInfo }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Classe do aviso da consulta (cor por gravidade). */
const CNPJ_NOTICE_CLASSES: Record<CnpjCheck["status"], string> = {
  idle: "hidden",
  loading: "text-gray-400",
  active: "text-emerald-400",
  inactive: "text-red-400",
  not_found: "text-red-400",
  unavailable: "text-amber-300",
};

/** Resumo da empresa devolvida pela BrasilAPI (`Razão social · Cidade/UF`). */
function describeCompany(info: CnpjInfo): string {
  const name = info.razaoSocial ?? info.nomeFantasia;
  const location =
    info.municipio && info.uf ? `${info.municipio}/${info.uf}` : null;

  return [name, location].filter(Boolean).join(" · ");
}



/** Ordem usada para focar o primeiro campo inválido. */
const FIELD_ORDER: Field[] = [
  "owner_name",
  "establishment_name",
  "document_type",
  "document_number",
  "whatsapp",
  "slug",
];

/**
 * Converte o nome do campo devolvido pela API (`name`, `phone`…) no nome usado
 * no formulário — o endpoint aceita aliases por compatibilidade.
 */
const API_FIELD_MAP: Record<string, Field> = {
  owner_name: "owner_name",
  name: "establishment_name",
  establishment_name: "establishment_name",
  document_type: "document_type",
  document_number: "document_number",
  whatsapp: "whatsapp",
  phone: "whatsapp",
  slug: "slug",
};

const INPUT_BASE =
  "w-full rounded-xl border bg-gray-900/70 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 transition focus:outline-none focus:ring-1";
const INPUT_OK =
  "border-gray-700 focus:border-amber-400 focus:ring-amber-400";
const INPUT_ERROR =
  "border-red-500/70 focus:border-red-400 focus:ring-red-400";

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
 * O servidor revalida — esta checagem serve para dar feedback imediato.
 */
function validate(form: FormState): Errors {
  const errors: Errors = {};

  const ownerMessage = ownerNameError(form.owner_name);
  if (ownerMessage) errors.owner_name = ownerMessage;

  const draft: EstablishmentDraft = {
    name: form.establishment_name,
    document_type: form.document_type,
    document_number: form.document_number,
    whatsapp: form.whatsapp,
    slug: form.slug,
  };

  const draftErrors = validateEstablishmentDraft(draft);
  if (draftErrors.name) errors.establishment_name = draftErrors.name;
  if (draftErrors.document_type) errors.document_type = draftErrors.document_type;
  if (draftErrors.document_number)
    errors.document_number = draftErrors.document_number;
  if (draftErrors.whatsapp) errors.whatsapp = draftErrors.whatsapp;
  if (draftErrors.slug) errors.slug = draftErrors.slug;

  return errors;
}

/** Rótulo + input + mensagem de erro/hint (padrão visual do cadastro). */
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

/** ID real de cada campo no DOM (usado para focar o erro da API). */
const FIELD_IDS: Record<Field, string> = {
  owner_name: "owner_name",
  establishment_name: "establishment_name",
  document_type: "document_type",
  document_number: "document_number",
  whatsapp: "whatsapp",
  slug: "slug",
};

/**
 * Etapa 2 do cadastro (`/completar-cadastro`).
 *
 * Usada por quem já criou o acesso (Google ou e-mail + senha): a conta existe,
 * falta a loja.
 *  1. Pré-preenche o responsável com o nome do perfil (Google) ou derivado do
 *     e-mail (editável).
 *  2. Valida no cliente com `lib/registration.ts` (mesmas mensagens da API).
 *  3. Com CNPJ, consulta a situação cadastral na BrasilAPI (`lib/cnpj.ts`) e só
 *     deixa seguir quando a empresa está ATIVA — CNPJ baixado/inapto/suspenso ou
 *     inexistente fica bloqueado antes do envio.
 *  4. Envia para `POST /api/signup/establishment`, que cria/atualiza a loja,
 *     promove o perfil a `admin` e marca `onboarding_complete`.
 *  5. Abre o painel.
 */
export function CompleteSignupForm({
  email,
  initialOwnerName,
  notice,
}: {
  email: string;
  initialOwnerName: string;
  /**
   * Aviso opcional vindo de `?erro=loja_ausente` (guard do painel).
   * Aparece acima do formulário para explicar por que o usuário foi
   * encaminhado ao onboarding.
   */
  notice?: string | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [form, setForm] = useState<FormState>({
    owner_name: initialOwnerName,
    establishment_name: "",
    document_type: "cpf",
    document_number: "",
    whatsapp: "",
    slug: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  // Enquanto o usuário não editar o link manualmente, ele acompanha o nome.
  const [slugTouched, setSlugTouched] = useState(false);
  /**
   * Última consulta de CNPJ concluída: a qual número ela se refere e o
   * resultado. Guardar os dígitos permite derivar "carregando" sem `setState`
   * dentro do efeito (ver `cnpjCheck`).
   */
  const [cnpjResult, setCnpjResult] = useState<{
    digits: string;
    check: CnpjCheck;
  } | null>(null);

  /**
   * Espelho de `slugTouched` para uso dentro do efeito de consulta do CNPJ
   * (evita reexecutar a consulta só porque o link passou a ser manual).
   */
  const slugTouchedRef = useRef(false);

  const slugPreview = slugify(form.slug || form.establishment_name);

  /** Dígitos do documento (a consulta só roda com CNPJ completo). */
  const documentDigits = onlyDigits(form.document_number);

  /** CNPJ válido e com os 14 dígitos: hora de consultar a Receita. */
  const isCnpjComplete =
    form.document_type === "cnpj" && documentDigits.length === 14;

  /**
   * Estado efetivo da consulta, **derivado** (nada de `setState` no efeito):
   *  - CPF/incompleto → `idle`;
   *  - resultado já conhecido para este número → usa o resultado;
   *  - caso contrário → `loading` (a consulta está em andamento).
   */
  const cnpjCheck: CnpjCheck = !isCnpjComplete
    ? { status: "idle" }
    : cnpjResult && cnpjResult.digits === documentDigits
      ? cnpjResult.check
      : { status: "loading" };

  /**
   * Consulta a situação cadastral quando os 14 dígitos do CNPJ estão completos.
   *
   * A chamada sai do navegador (a BrasilAPI libera CORS) e é cancelada assim
   * que o número muda. Falha de rede/timeout nunca bloqueia o cadastro; só a
   * reprovação da Receita (situação ≠ ATIVA ou CNPJ inexistente) impede o
   * envio — ver `blockingDocumentError`.
   */
  useEffect(() => {
    if (!isCnpjComplete) return;

    const digits = documentDigits;
    const controller = new AbortController();

    void lookupCnpj(digits, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;

      if (!result.ok) {
        setCnpjResult({
          digits,
          check:
            result.reason === "not_found"
              ? { status: "not_found" }
              : result.reason === "invalid"
                ? // Dígitos verificadores: o erro local de validação já explica.
                  { status: "idle" }
                : { status: "unavailable" },
        });
        return;
      }

      const isActive = result.info.situacao === CNPJ_SITUACAO_ATIVA;

      setCnpjResult({
        digits,
        check: isActive
          ? { status: "active", info: result.info }
          : { status: "inactive", info: result.info },
      });

      if (!isActive) return;

      // Empresa ATIVA: sugere o nome e mantém o link em sincronia, sem
      // sobrescrever nada que o usuário já tenha digitado.
      const companyName = (result.info.nomeFantasia ?? result.info.razaoSocial)
        ?.trim()
        .slice(0, MAX_NAME_LENGTH);

      if (!companyName) return;

      setForm((prev) => {
        if (prev.establishment_name.trim()) return prev;

        return {
          ...prev,
          establishment_name: companyName,
          slug: slugTouchedRef.current
            ? prev.slug
            : slugify(companyName).slice(0, MAX_SLUG_LENGTH),
        };
      });
    });

    return () => controller.abort();
  }, [isCnpjComplete, documentDigits]);

  /** Texto do aviso da consulta (vazio quando não há nada a mostrar). */
  const cnpjNotice =
    cnpjCheck.status === "loading"
      ? "Consultando CNPJ na Receita Federal..."
      : cnpjCheck.status === "active"
        ? `CNPJ ativo na Receita${describeCompany(cnpjCheck.info) ? `: ${describeCompany(cnpjCheck.info)}` : ""}.`
        : cnpjCheck.status === "inactive"
          ? `Situação cadastral na Receita: ${cnpjCheck.info.situacao ?? "irregular"}. Só empresas ATIVAS podem cadastrar uma loja.`
          : cnpjCheck.status === "not_found"
            ? "CNPJ não encontrado na Receita Federal. Confira os números digitados."
            : cnpjCheck.status === "unavailable"
              ? "Não foi possível consultar a Receita Federal agora. Você pode continuar: o documento é validado novamente ao salvar."
              : "";

  /**
   * Trava o envio quando a Receita reprova o CNPJ consultado.
   * `null` para CPF, consulta pendente/indisponível ou CNPJ ATIVO.
   */
  const blockingDocumentError = (): string | null => {
    if (form.document_type !== "cnpj") return null;

    if (cnpjCheck.status === "inactive") {
      return `CNPJ com situação cadastral ${
        cnpjCheck.info.situacao ?? "irregular"
      } na Receita Federal. Regularize o documento para continuar.`;
    }

    if (cnpjCheck.status === "not_found") {
      return "CNPJ não encontrado na Receita Federal. Confira os números digitados.";
    }

    return null;
  };

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
    setSlugTouched(true);
    slugTouchedRef.current = true;
    setForm((prev) => ({ ...prev, slug: sanitizeSlugInput(value) }));
    clearError("slug");
  };

  const handleDocumentTypeChange = (type: DocumentType) => {
    setForm((prev) => ({
      ...prev,
      document_type: type,
      // Reaplica a máscara no mesmo número (CPF → CNPJ trunca em 14 dígitos).
      document_number: formatDocumentInput(prev.document_number, type),
    }));
    clearError("document_type");
    clearError("document_number");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const nextErrors = validate(form);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setFormError(null);
      const first = FIELD_ORDER.find((field) => nextErrors[field]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }

    // Consulta da Receita reprovou o CNPJ (baixado/inapta/suspenso ou
    // inexistente): não faz sentido mandar para a API — a loja não poderia ser
    // criada com um documento inválido.
    const documentBlock = blockingDocumentError();
    if (documentBlock) {
      setErrors({ document_number: documentBlock });
      setFormError(null);
      document.getElementById(FIELD_IDS.document_number)?.focus();
      return;
    }

    setIsSubmitting(true);
    setFormError(null);
    setErrors({});

    const draft = normalizeEstablishmentDraft({
      name: form.establishment_name,
      document_type: form.document_type,
      document_number: form.document_number,
      whatsapp: form.whatsapp,
      slug: form.slug,
    });

    try {
      const response = await fetch("/api/signup/establishment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_name: form.owner_name.trim(),
          name: draft.name,
          document_type: draft.documentType,
          document_number: draft.documentNumber,
          whatsapp: draft.whatsapp,
          slug: draft.slug,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        field?: string;
      };

      if (!response.ok) {
        const field = payload.field ? API_FIELD_MAP[payload.field] : undefined;

        if (field && response.status !== 401) {
          setErrors({
            [field]: payload.error ?? "Verifique este campo e tente novamente.",
          });
          document.getElementById(FIELD_IDS[field])?.focus();
          setIsSubmitting(false);
          return;
        }

        setFormError(
          response.status === 401
            ? "Sua sessão expirou. Entre novamente para concluir o cadastro."
            : (payload.error ?? "Não foi possível salvar seus dados. Tente novamente.")
        );
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

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    await supabase.auth.signOut();
    router.replace("/cadastro");
    router.refresh();
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
            Falta pouco para seu cardápio vender pelo{" "}
            <span className="bg-gradient-to-r from-amber-300 via-amber-400 to-orange-400 bg-clip-text text-transparent">
              WhatsApp
            </span>
          </h1>

          <p className="mt-4 max-w-md text-sm leading-relaxed text-gray-400">
            Sua conta já está criada. Só precisamos dos dados da loja para
            publicar o cardápio e liberar o painel — leva menos de 2 minutos.
          </p>

          <ul className="mt-8 space-y-3 text-sm text-gray-300">
            <li className="flex items-start gap-2.5">
              <span aria-hidden className="mt-0.5 text-amber-400">
                ✓
              </span>
              {TRIAL_DAYS} dias grátis, sem cartão de crédito
            </li>
            <li className="flex items-start gap-2.5">
              <span aria-hidden className="mt-0.5 text-amber-400">
                ✓
              </span>
              Pedidos organizados direto no seu WhatsApp
            </li>
            <li className="flex items-start gap-2.5">
              <span aria-hidden className="mt-0.5 text-amber-400">
                ✓
              </span>
              Link próprio para divulgar no Instagram e no Google
            </li>
          </ul>
        </aside>

        <div className="w-full">
          <div className="rounded-3xl border border-white/10 bg-[#0b0f14]/90 p-6 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
            <h2 className="text-xl font-black tracking-tight sm:text-2xl">
              Complete seu cadastro
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              Você entrou como{" "}
              <span className="font-semibold text-gray-200">{email}</span>.
              Informe os dados do estabelecimento para começar a usar o painel.
            </p>

            {notice ? (
              <p
                role="status"
                className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-xs font-medium leading-relaxed text-amber-200"
              >
                {notice}
              </p>
            ) : null}

            <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
              <FieldShell
                htmlFor="owner_name"
                label="Seu nome"
                error={errors.owner_name}
              >
                <input
                  id="owner_name"
                  name="owner_name"
                  type="text"
                  value={form.owner_name}
                  onChange={(event) => updateField("owner_name", event.target.value)}
                  autoComplete="name"
                  maxLength={80}
                  placeholder="Ex.: Ana Souza"
                  aria-invalid={Boolean(errors.owner_name)}
                  aria-describedby={
                    errors.owner_name ? "owner_name-error" : undefined
                  }
                  className={`${INPUT_BASE} ${errors.owner_name ? INPUT_ERROR : INPUT_OK}`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="establishment_name"
                label="Nome do estabelecimento"
                hint="Aparece no topo do seu cardápio digital."
                error={errors.establishment_name}
              >
                <input
                  id="establishment_name"
                  name="establishment_name"
                  type="text"
                  value={form.establishment_name}
                  onChange={(event) =>
                    handleEstablishmentNameChange(event.target.value)
                  }
                  autoComplete="organization"
                  maxLength={80}
                  placeholder="Ex.: Esquina do Sabor"
                  aria-invalid={Boolean(errors.establishment_name)}
                  aria-describedby={
                    errors.establishment_name
                      ? "establishment_name-error"
                      : "establishment_name-hint"
                  }
                  className={`${INPUT_BASE} ${errors.establishment_name ? INPUT_ERROR : INPUT_OK}`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="document_number"
                label={`${DOCUMENT_TYPE_LABELS[form.document_type]} do responsável`}
                hint="Usamos o documento apenas para emitir a nota fiscal da assinatura."
                error={errors.document_type ?? errors.document_number}
              >
                <div
                  id="document_type"
                  role="radiogroup"
                  aria-label="Tipo de documento"
                  tabIndex={-1}
                  className="mb-2 grid grid-cols-2 gap-2"
                >
                  {(Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]).map(
                    (type) => {
                      const active = form.document_type === type;
                      return (
                        <button
                          key={type}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => handleDocumentTypeChange(type)}
                          className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                            active
                              ? "border-amber-400/70 bg-amber-400/10 text-amber-300"
                              : "border-gray-700 bg-gray-900/70 text-gray-400 hover:border-gray-600 hover:text-gray-200"
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
                  onChange={(event) =>
                    updateField(
                      "document_number",
                      formatDocumentInput(event.target.value, form.document_type)
                    )
                  }
                  placeholder={DOCUMENT_PLACEHOLDERS[form.document_type]}
                  aria-invalid={Boolean(
                    errors.document_type ?? errors.document_number
                  )}
                  aria-describedby={
                    errors.document_type ?? errors.document_number
                      ? "document_number-error"
                      : "document_number-hint"
                  }
                  className={`${INPUT_BASE} ${
                    errors.document_type ?? errors.document_number
                      ? INPUT_ERROR
                      : INPUT_OK
                  }`}
                />

                {form.document_type === "cnpj" && cnpjNotice && (
                  <p
                    aria-live="polite"
                    className={`mt-2 text-xs font-medium ${
                      CNPJ_NOTICE_CLASSES[cnpjCheck.status]
                    }`}
                  >
                    {cnpjNotice}
                  </p>
                )}
              </FieldShell>

              <FieldShell
                htmlFor="whatsapp"
                label="WhatsApp"
                hint="É por aqui que você recebe os pedidos."
                error={errors.whatsapp}
              >
                <input
                  id="whatsapp"
                  name="whatsapp"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={form.whatsapp}
                  onChange={(event) =>
                    updateField("whatsapp", formatWhatsappInput(event.target.value))
                  }
                  placeholder="(11) 99999-9999"
                  aria-invalid={Boolean(errors.whatsapp)}
                  aria-describedby={
                    errors.whatsapp ? "whatsapp-error" : "whatsapp-hint"
                  }
                  className={`${INPUT_BASE} ${errors.whatsapp ? INPUT_ERROR : INPUT_OK}`}
                />
              </FieldShell>

              <FieldShell
                htmlFor="slug"
                label="Link do cardápio"
                hint={`Seu cardápio ficará em ipepper.com.br/${
                  slugPreview || "seu-restaurante"
                }`}
                error={errors.slug}
              >
                <div
                  className={`flex items-center overflow-hidden rounded-xl border bg-gray-900/70 transition focus-within:ring-1 ${
                    errors.slug
                      ? "border-red-500/70 focus-within:border-red-400 focus-within:ring-red-400"
                      : "border-gray-700 focus-within:border-amber-400 focus-within:ring-amber-400"
                  }`}
                >
                  <span className="shrink-0 border-r border-gray-700 px-3 py-2.5 text-sm text-gray-500">
                    ipepper.com.br/
                  </span>
                  <input
                    id="slug"
                    name="slug"
                    type="text"
                    value={form.slug}
                    onChange={(event) => handleSlugChange(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="meu-restaurante"
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={errors.slug ? "slug-error" : "slug-hint"}
                    className="w-full bg-transparent px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none"
                  />
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
                    Salvando seus dados...
                  </>
                ) : (
                  "Salvar e acessar o painel"
                )}
              </button>

              <p className="text-center text-xs text-gray-500">
                {TRIAL_DAYS} dias grátis · Sem cartão de crédito · Cancele
                quando quiser
              </p>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-gray-500">
            Entrou na conta errada?{" "}
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="font-semibold text-gray-300 underline decoration-gray-600 underline-offset-2 transition hover:text-amber-300 disabled:opacity-60"
            >
              {isSigningOut ? "Saindo..." : "Sair"}
            </button>
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

