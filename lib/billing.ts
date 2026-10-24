/**
 * Contrato compartilhado do checkout de assinatura (Asaas).
 *
 * Módulo isomórfico (sem APIs de servidor/navegador): usado pelas rotas
 * `/api/billing/*` — que validam o payload com as mesmas regras — e pelo
 * modal de checkout em `/painel/assinatura`.
 *
 * Nenhum dado de cartão é persistido: ele apenas trafega do formulário para a
 * rota de checkout e desta para o Asaas.
 */

import type { SubscriptionStatus } from "./subscriptions";

// ---------------------------------------------------------------------------
// Formas de pagamento
// ---------------------------------------------------------------------------

/** Formas de pagamento aceitas no checkout (`billingType` do Asaas). */
export const BILLING_TYPES = ["PIX", "CREDIT_CARD", "BOLETO"] as const;

export type BillingType = (typeof BILLING_TYPES)[number];

/** Rótulos usados no seletor de pagamento e nas mensagens de erro. */
export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  PIX: "Pix",
  CREDIT_CARD: "Cartão de Crédito",
  BOLETO: "Boleto",
};

/** Type guard para valores vindos do cliente. */
export function isBillingType(value: unknown): value is BillingType {
  return (
    typeof value === "string" &&
    (BILLING_TYPES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Status de cobrança
// ---------------------------------------------------------------------------

/** Status em que o dinheiro já entrou (à vista ou compensado). */
export const PAID_PAYMENT_STATUSES = [
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
] as const;

/**
 * `true` quando a cobrança já foi paga/confirmada.
 *
 * Vive no contrato isomórfico para que o modal (client) e as rotas (server)
 * usem a mesma regra sem importar o cliente HTTP do Asaas no bundle.
 */
export function isPaidPaymentStatus(
  status: string | null | undefined
): boolean {
  if (!status) return false;
  return (PAID_PAYMENT_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Normalização e máscaras
// ---------------------------------------------------------------------------

/** Remove tudo que não for dígito (CPF/CNPJ, telefone, CEP, cartão). */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** `true` quando o e-mail tem o formato mínimo aceito pelo checkout. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** Máscara progressiva de CPF (000.000.000-00) ou CNPJ (00.000.000/0000-00). */
export function formatCpfCnpjInput(value: string): string {
  const digits = onlyDigits(value).slice(0, 14);

  if (digits.length <= 11) {
    return digits
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2");
  }

  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

/** Máscara progressiva de telefone: (00) 0000-0000 ou (00) 00000-0000. */
export function formatPhoneInput(value: string): string {
  const digits = onlyDigits(value).slice(0, 11);

  if (digits.length <= 10) {
    return digits
      .replace(/^(\d{2})(\d)/, "($1) $2")
      .replace(/(\d{4})(\d)/, "$1-$2");
  }

  return digits
    .replace(/^(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d)/, "$1-$2");
}

/** Máscara progressiva do cartão (grupos de 4 dígitos). */
export function formatCardNumberInput(value: string): string {
  return onlyDigits(value)
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** Máscara progressiva de CEP (00000-000). */
export function formatPostalCodeInput(value: string): string {
  return onlyDigits(value)
    .slice(0, 8)
    .replace(/^(\d{5})(\d)/, "$1-$2");
}

// ---------------------------------------------------------------------------
// Payload do checkout
// ---------------------------------------------------------------------------

/** Dados de faturamento (Passo 1 do modal). */
export interface BillingCustomerInput {
  name: string;
  email: string;
  /** CPF ou CNPJ (somente dígitos na API). */
  cpfCnpj: string;
  /** Telefone com DDD (somente dígitos na API). */
  phone: string;
}

/** Dados do cartão de crédito (somente em memória; nunca persistidos). */
export interface CreditCardInput {
  holderName: string;
  /** Número do cartão (somente dígitos na API). */
  number: string;
  /** Mês de validade com 1–2 dígitos (ex.: "9" ou "09"). */
  expiryMonth: string;
  /** Ano de validade com 4 dígitos (ex.: "2030"). */
  expiryYear: string;
  /** Código de segurança (3–4 dígitos). */
  ccv: string;
}

/** Dados do titular exigidos pelo Asaas para cobrança no cartão. */
export interface CreditCardHolderInput {
  /** CEP do titular (somente dígitos na API). */
  postalCode: string;
  /** Número do endereço do titular. */
  addressNumber: string;
}

/** Body do `POST /api/billing/checkout`. */
export interface CheckoutRequest {
  /** Necessário apenas para super_admin (o admin usa a própria loja). */
  establishment_id?: string;
  billingType: BillingType;
  customer: BillingCustomerInput;
  creditCard?: CreditCardInput;
  creditCardHolderInfo?: CreditCardHolderInput;
}

/** QR Code Pix devolvido ao modal após a criação da cobrança. */
export interface CheckoutPixInfo {
  paymentId: string;
  /** Imagem PNG em Base64 (sem o prefixo `data:`). */
  encodedImage: string;
  /** Pix Copia e Cola. */
  payload: string;
  expirationDate: string | null;
  invoiceUrl: string | null;
}

/** Boleto devolvido ao modal (link para visualização/impressão). */
export interface CheckoutBoletoInfo {
  paymentId: string;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
  dueDate: string;
  value: number;
}

/** Resposta do `POST /api/billing/checkout`. */
export interface CheckoutResponse {
  subscriptionId: string;
  customerId: string;
  billingType: BillingType;
  /** Status da primeira cobrança no Asaas (null quando ainda não gerada). */
  paymentStatus: string | null;
  /** Situação da loja já persistida no banco. */
  subscriptionStatus: SubscriptionStatus;
  pix?: CheckoutPixInfo;
  boleto?: CheckoutBoletoInfo;
}

/** Cobrança resumida devolvida pelo `GET /api/billing/status`. */
export interface BillingStatusPayment {
  id: string;
  status: string;
  billingType: BillingType | null;
  value: number;
  dueDate: string | null;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
  /** Data de confirmação/recebimento (ISO), quando paga. */
  paidAt: string | null;
}

/** Resposta do `GET /api/billing/status` (polling do modal). */
export interface BillingStatusResponse {
  subscriptionStatus: SubscriptionStatus;
  /** Regra única de acesso (ver `isSubscriptionActive`). */
  isActive: boolean;
  planId: string | null;
  trialEndsAt: string | null;
  payment: BillingStatusPayment | null;
  /** As colunas de assinatura ainda não existem no banco. */
  schemaPending: boolean;
  /** Momento da consulta (ISO) — útil para logs do polling. */
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Validação (mesmas regras no cliente e no servidor)
// ---------------------------------------------------------------------------

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 80;
const MIN_CARD_HOLDER_LENGTH = 3;

/**
 * Valida os dados de faturamento.
 * Retorna a mensagem do primeiro campo inválido ou `null` quando está tudo ok.
 *
 * O CPF/CNPJ é validado apenas por tamanho (11 ou 14 dígitos): o dígito
 * verificador fica a cargo do Asaas, para não bloquear dados de teste no
 * Sandbox.
 */
export function validateBillingCustomer(
  customer: BillingCustomerInput
): string | null {
  const name = customer.name.trim();
  if (name.length < MIN_NAME_LENGTH) {
    return "Informe o nome completo do responsável.";
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`;
  }

  if (!isValidEmail(customer.email)) {
    return "Informe um e-mail válido para o faturamento.";
  }

  const cpfCnpj = onlyDigits(customer.cpfCnpj);
  if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
    return "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.";
  }

  const phone = onlyDigits(customer.phone);
  if (phone.length !== 10 && phone.length !== 11) {
    return "Informe o telefone com DDD (10 ou 11 dígitos).";
  }

  return null;
}

/**
 * Valida os dados do cartão de crédito.
 * Retorna a mensagem do primeiro campo inválido ou `null` quando está tudo ok.
 */
export function validateCreditCard(
  card: CreditCardInput,
  holder: CreditCardHolderInput,
  now: Date = new Date()
): string | null {
  if (card.holderName.trim().length < MIN_CARD_HOLDER_LENGTH) {
    return "Informe o nome impresso no cartão.";
  }

  const number = onlyDigits(card.number);
  if (number.length < 13 || number.length > 19) {
    return "Informe um número de cartão válido.";
  }

  const month = Number.parseInt(card.expiryMonth, 10);
  const year = Number.parseInt(card.expiryYear, 10);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return "Informe o mês de validade do cartão (01 a 12).";
  }
  if (
    !Number.isInteger(year) ||
    year < currentYear ||
    year > currentYear + 30
  ) {
    return "Informe o ano de validade do cartão com 4 dígitos.";
  }
  if (year === currentYear && month < currentMonth) {
    return "O cartão informado está vencido.";
  }

  const ccv = onlyDigits(card.ccv);
  if (ccv.length < 3 || ccv.length > 4) {
    return "Informe o código de segurança (CVV) do cartão.";
  }

  if (onlyDigits(holder.postalCode).length !== 8) {
    return "Informe o CEP do titular do cartão (8 dígitos).";
  }

  if (!holder.addressNumber.trim()) {
    return "Informe o número do endereço do titular do cartão.";
  }

  return null;
}

