/**
 * Contrato compartilhado da configuração de recebimento online (Asaas Split).
 *
 * Módulo isomórfico (sem APIs de servidor/navegador): usado pela tela
 * `/painel/configuracoes` (formulário e prévia) e pela rota
 * `POST /api/asaas/subaccount` (validação e normalização antes de falar com o
 * gateway). Nenhum segredo do Asaas transita por aqui.
 */

import {
  isValidCpfCnpj,
  isValidEmail,
  onlyDigits,
} from "./billing";

/** Taxa fixa da plataforma por pedido pago online, em centavos (R$ 0,50). */
export const PLATFORM_FEE_CENTS = 50;

/** Rótulo da taxa cobrada pela plataforma (exibido ao lojista). */
export const PLATFORM_FEE_LABEL = "R$ 0,50";

/** Tipos de empresa aceitos pelo Asaas para subcontas (pessoa jurídica). */
export const ASAAS_COMPANY_TYPES = [
  "MEI",
  "LIMITED",
  "INDIVIDUAL",
  "ASSOCIATION",
] as const;

export type AsaasCompanyType = (typeof ASAAS_COMPANY_TYPES)[number];

/** Rótulos em português dos tipos de empresa do Asaas. */
export const ASAAS_COMPANY_TYPE_LABELS: Record<AsaasCompanyType, string> = {
  MEI: "MEI",
  LIMITED: "Sociedade Limitada (Ltda)",
  INDIVIDUAL: "Empresário Individual",
  ASSOCIATION: "Associação",
};

/** Type guard para o tipo de empresa vindo do formulário. */
export function isAsaasCompanyType(value: unknown): value is AsaasCompanyType {
  return (
    typeof value === "string" &&
    (ASAAS_COMPANY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Estado do formulário de recebimento online. Todos os campos são strings
 * (como aparecem nos inputs) — a normalização para o formato do gateway
 * acontece em `validateAsaasSubaccountForm`.
 */
export interface AsaasSubaccountForm {
  /** Razão social (PJ) ou nome completo (PF). */
  name: string;
  /** CPF (11) ou CNPJ (14), com ou sem máscara. */
  cpfCnpj: string;
  email: string;
  /** Telefone/celular com DDD (vira `mobilePhone` no Asaas). */
  phone: string;
  /** Faturamento/renda mensal em reais (ex.: "5000" ou "5.000,00"). */
  incomeValue: string;
  /** CEP do endereço da subconta (obrigatório no Asaas). */
  postalCode: string;
  /** Logradouro (rua/avenida). */
  address: string;
  addressNumber: string;
  /** Complemento (opcional). */
  complement: string;
  /** Bairro. */
  province: string;
  /** Tipo de empresa — obrigatório apenas para CNPJ (pessoa jurídica). */
  companyType: AsaasCompanyType | "";
  /** Data de nascimento (YYYY-MM-DD) — obrigatória apenas para CPF. */
  birthDate: string;
  /** Chave PIX usada para o lojista resgatar o repasse. */
  pixKey: string;
  /** Liga/desliga o PIX online no cardápio. */
  acceptPixOnline: boolean;
}

/** Estado inicial (vazio) do formulário de recebimento online. */
export const EMPTY_ASAAS_SUBACCOUNT_FORM: AsaasSubaccountForm = {
  name: "",
  cpfCnpj: "",
  email: "",
  phone: "",
  incomeValue: "",
  postalCode: "",
  address: "",
  addressNumber: "",
  complement: "",
  province: "",
  companyType: "",
  birthDate: "",
  pixKey: "",
  acceptPixOnline: false,
};

/**
 * Snapshot dos dados de recebimento da subconta, persistido em
 * `establishments.asaas_subaccount` (jsonb) para reabrir o formulário já
 * preenchido. Valores já normalizados (documento/telefone/CEP só com dígitos).
 */
export interface AsaasSubaccountProfile {
  name: string;
  cpfCnpj: string;
  email: string;
  phone: string;
  incomeValue: number;
  postalCode: string;
  address: string;
  addressNumber: string;
  complement: string;
  province: string;
  companyType: AsaasCompanyType | null;
  birthDate: string | null;
}

/** Resultado normalizado (pronto para o gateway) de um formulário válido. */
export interface NormalizedAsaasSubaccount {
  profile: AsaasSubaccountProfile;
  pixKey: string;
  acceptPixOnline: boolean;
  /** `true` quando o documento é CNPJ (pessoa jurídica). */
  isCompany: boolean;
}

export type AsaasSubaccountValidation =
  | { ok: true; data: NormalizedAsaasSubaccount }
  | { ok: false; error: string };

/** Converte um valor em reais digitado (ex.: "5.000,00") em número. */
function parseMoneyToReais(value: string): number {
  const cleaned = value.replace(/[^\d,.-]/g, "").trim();
  if (!cleaned) return Number.NaN;
  // Com vírgula: assume "." como milhar e "," como decimal (padrão pt-BR).
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Valida e normaliza o formulário de recebimento online.
 *
 * Regras espelham o que o Asaas exige para criar uma subconta (POST /accounts):
 * nome, e-mail, CPF/CNPJ, celular, faturamento, endereço completo (logradouro,
 * número, bairro e CEP). Além disso, exigimos a chave PIX de resgate para que o
 * lojista consiga receber o repasse. `companyType` só é exigido para CNPJ e
 * `birthDate` só para CPF.
 */
export function validateAsaasSubaccountForm(
  form: AsaasSubaccountForm
): AsaasSubaccountValidation {
  const name = form.name.trim();
  if (name.length < 3) {
    return {
      ok: false,
      error: "Informe a razão social ou o nome completo (mínimo 3 caracteres).",
    };
  }

  const cpfCnpj = onlyDigits(form.cpfCnpj);
  if (!isValidCpfCnpj(cpfCnpj)) {
    return {
      ok: false,
      error: "CPF/CNPJ inválido. Confira os números informados.",
    };
  }
  const isCompany = cpfCnpj.length === 14;

  const email = form.email.trim();
  if (!isValidEmail(email)) {
    return { ok: false, error: "Informe um e-mail válido para a subconta." };
  }

  const phone = onlyDigits(form.phone);
  if (phone.length < 10) {
    return { ok: false, error: "Informe um telefone/celular válido com DDD." };
  }

  const incomeValue = parseMoneyToReais(form.incomeValue);
  if (!Number.isFinite(incomeValue) || incomeValue <= 0) {
    return {
      ok: false,
      error: "Informe o faturamento/renda mensal (maior que zero).",
    };
  }

  const postalCode = onlyDigits(form.postalCode);
  if (postalCode.length !== 8) {
    return { ok: false, error: "Informe um CEP válido (8 dígitos)." };
  }

  const address = form.address.trim();
  if (address.length < 3) {
    return { ok: false, error: "Informe o logradouro (rua/avenida) do endereço." };
  }

  const addressNumber = form.addressNumber.trim();
  if (!addressNumber) {
    return { ok: false, error: "Informe o número do endereço." };
  }

  const province = form.province.trim();
  if (province.length < 2) {
    return { ok: false, error: "Informe o bairro do endereço." };
  }

  // Pessoa jurídica (CNPJ): exige o tipo de empresa.
  let companyType: AsaasCompanyType | null = null;
  if (isCompany) {
    if (!isAsaasCompanyType(form.companyType)) {
      return {
        ok: false,
        error: "Selecione o tipo de empresa (MEI, Ltda, Empresário Individual…).",
      };
    }
    companyType = form.companyType;
  }

  // Pessoa física (CPF): exige a data de nascimento.
  let birthDate: string | null = null;
  if (!isCompany) {
    const raw = form.birthDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return {
        ok: false,
        error: "Informe a data de nascimento do titular (CPF).",
      };
    }
    birthDate = raw;
  }

  const pixKey = form.pixKey.trim();
  if (pixKey.length < 5) {
    return {
      ok: false,
      error:
        "Informe a chave PIX de resgate (e-mail, telefone, CPF/CNPJ ou chave aleatória).",
    };
  }

  return {
    ok: true,
    data: {
      profile: {
        name,
        cpfCnpj,
        email,
        phone,
        incomeValue,
        postalCode,
        address,
        addressNumber,
        complement: form.complement.trim(),
        province,
        companyType,
        birthDate,
      },
      pixKey,
      acceptPixOnline: Boolean(form.acceptPixOnline),
      isCompany,
    },
  };
}

// ---------------------------------------------------------------------------
// Situação do recebimento online (badge ao lado do título da seção)
// ---------------------------------------------------------------------------

/**
 * Situação do recebimento online exibida no painel:
 *  - `active`   → subconta criada e PIX online ligado (recebendo);
 *  - `paused`   → subconta criada, mas o PIX online está desligado no cardápio;
 *  - `inactive` → nenhuma subconta (dados de recebimento ainda não enviados).
 */
export type OnlinePaymentStatusTone = "active" | "paused" | "inactive";

export interface OnlinePaymentStatus {
  tone: OnlinePaymentStatusTone;
  /** Emoji do badge — o estado não depende apenas da cor. */
  emoji: string;
  /** Rótulo curto exibido no badge. */
  label: string;
  /** Explicação de uma linha (texto de apoio / `title` do badge). */
  description: string;
}

/**
 * Resolve o badge de situação a partir do `asaas_account_id` (subconta criada)
 * e da preferência "Aceitar PIX Online". Módulo isomórfico: a mesma regra vale
 * para a tela de configurações e para qualquer resumo do painel.
 */
export function resolveOnlinePaymentStatus(input: {
  hasSubaccount: boolean;
  acceptPixOnline: boolean;
}): OnlinePaymentStatus {
  if (!input.hasSubaccount) {
    return {
      tone: "inactive",
      emoji: "⚪",
      label: "Inativo / Não conectado",
      description:
        "Envie os dados de recebimento abaixo para criar a sua conta no Asaas e ativar o PIX online.",
    };
  }

  if (!input.acceptPixOnline) {
    return {
      tone: "paused",
      emoji: "🟡",
      label: "Conectado · PIX desativado",
      description:
        "Sua conta de recebimento está pronta. Ligue o PIX online para aceitar pagamentos no checkout.",
    };
  }

  return {
    tone: "active",
    emoji: "🟢",
    label: "Ativo / Conectado",
    description:
      "PIX online ativo: os pedidos pagos no checkout caem direto na sua conta de recebimento.",
  };
}
