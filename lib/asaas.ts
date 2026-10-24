/**
 * Cliente HTTP do Asaas (server-side apenas).
 *
 * Nunca deve ser importado por um Client Component: a `ASAAS_API_KEY` é um
 * segredo e o Asaas exige a chave no header `access_token`.
 *
 * Endpoints usados:
 *  - `POST /customers`                              → cria o cliente da loja;
 *  - `GET  /customers?email/cpfCnpj=`               → reaproveita cliente existente;
 *  - `POST /subscriptions` (e `/subscriptions/`)    → assinatura mensal recorrente;
 *  - `GET  /subscriptions/{id}/payments`            → cobranças geradas pela assinatura;
 *  - `GET  /payments/{id}/pixQrCode`                → QR Code dinâmico do Pix.
 *
 * Docs: https://docs.asaas.com/reference
 */

import { onlyDigits, type BillingType } from "./billing";

/** URL do Sandbox quando `ASAAS_API_URL` não está configurada. */
const DEFAULT_API_URL = "https://sandbox.asaas.com/api/v3";

/** O Asaas recomenda timeout mínimo de 60s na criação de assinaturas. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Erro normalizado da API do Asaas (nunca expõe a API key). */
export class AsaasError extends Error {
  /** Status HTTP devolvido pelo Asaas (ou 500/502 quando local). */
  readonly status: number;
  /** Código do erro no Asaas (ex.: `invalid_cpfCnpj`). */
  readonly code: string | null;

  constructor(message: string, status = 502, code: string | null = null) {
    super(message);
    this.name = "AsaasError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tipos das respostas do Asaas (somente os campos que consumimos)
// ---------------------------------------------------------------------------

export interface AsaasCustomer {
  id: string;
  name?: string;
  email?: string;
  cpfCnpj?: string;
  phone?: string;
  externalReference?: string | null;
}

export interface AsaasSubscription {
  id: string;
  customer: string;
  billingType: BillingType;
  value: number;
  nextDueDate: string;
  cycle: string;
  status: "ACTIVE" | "EXPIRED" | "INACTIVE";
  description?: string | null;
}

export interface AsaasPayment {
  id: string;
  customer: string;
  subscription?: string | null;
  billingType: BillingType;
  status: string;
  value: number;
  netValue?: number;
  dueDate: string;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  description?: string | null;
}

interface AsaasListResponse<T> {
  object: "list";
  hasMore: boolean;
  totalCount: number;
  limit?: number;
  offset?: number;
  data: T[];
}

export interface AsaasPixQrCode {
  /** Imagem PNG em Base64 (sem prefixo `data:`). */
  encodedImage: string;
  /** Pix Copia e Cola. */
  payload: string;
  /** Ex.: "2026-11-22 23:59:59" (horário de Brasília). */
  expirationDate: string | null;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Infra HTTP
// ---------------------------------------------------------------------------

/** Configuração lida em tempo de execução (erro claro quando ausente). */
function getConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.ASAAS_API_KEY?.trim();
  if (!apiKey) {
    throw new AsaasError(
      "Pagamento indisponível: ASAAS_API_KEY não configurada no servidor.",
      500,
      "missing_api_key"
    );
  }

  const baseUrl = (
    process.env.ASAAS_API_URL?.trim() || DEFAULT_API_URL
  ).replace(/\/+$/, "");

  return { apiKey, baseUrl };
}

/** `true` quando o Asaas está configurado (usado por diagnósticos). */
export function isAsaasConfigured(): boolean {
  return Boolean(process.env.ASAAS_API_KEY?.trim());
}

interface AsaasErrorBody {
  errors?: Array<{ code?: string; description?: string }>;
}

/**
 * Executa uma requisição autenticada e devolve o JSON tipado.
 * Todo erro vira `AsaasError` com a descrição em português do Asaas.
 */
async function asaasRequest<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" }
): Promise<T> {
  const { apiKey, baseUrl } = getConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        access_token: apiKey,
        // O Asaas pede um User-Agent identificando a aplicação.
        "User-Agent": "Ipepper-Delivery/1.0.0",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AsaasError(
        "O Asaas demorou demais para responder. Tente novamente em instantes.",
        504,
        "gateway_timeout"
      );
    }
    throw new AsaasError(
      "Não foi possível conectar ao Asaas. Verifique a conexão do servidor.",
      502,
      "gateway_unreachable"
    );
  } finally {
    clearTimeout(timeout);
  }

  const payload = (await response
    .json()
    .catch(() => null)) as (T & AsaasErrorBody) | null;

  if (!response.ok) {
    const firstError = payload?.errors?.[0];
    throw new AsaasError(
      firstError?.description ||
        `O Asaas recusou a operação (HTTP ${response.status}).`,
      response.status,
      firstError?.code ?? null
    );
  }

  if (!payload) {
    throw new AsaasError(
      "O Asaas devolveu uma resposta inválida.",
      502,
      "invalid_response"
    );
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Datas e status
// ---------------------------------------------------------------------------

/**
 * Data de hoje (`YYYY-MM-DD`) no fuso de Brasília — formato do `nextDueDate`.
 * O servidor pode rodar em UTC, então não usamos `toISOString()` direto.
 */
export function formatAsaasDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Status de cobrança em que o dinheiro já entrou (à vista ou compensado). */
export { PAID_PAYMENT_STATUSES, isPaidPaymentStatus } from "./billing";

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

export interface FindOrCreateCustomerInput {
  name: string;
  email: string;
  /** CPF ou CNPJ (com ou sem máscara). */
  cpfCnpj: string;
  /** Telefone com DDD (com ou sem máscara). */
  phone: string;
  /** Identificador da loja no nosso banco (rastreabilidade). */
  externalReference?: string;
}

/** Busca um cliente por e-mail ou CPF/CNPJ (1º resultado). */
async function findCustomerBy(
  params: { email?: string; cpfCnpj?: string }
): Promise<AsaasCustomer | null> {
  const query = new URLSearchParams({ limit: "1" });
  if (params.email) query.set("email", params.email);
  if (params.cpfCnpj) query.set("cpfCnpj", params.cpfCnpj);

  const list = await asaasRequest<AsaasListResponse<AsaasCustomer>>(
    `/customers?${query.toString()}`
  );

  return list.data?.[0] ?? null;
}

/**
 * Reaproveita o cliente do Asaas (por e-mail ou CPF/CNPJ) ou cria um novo.
 *
 * O Asaas não permite dois clientes com o mesmo CPF/CNPJ; por isso, se a
 * criação falhar por duplicidade (corrida entre duas tentativas), buscamos o
 * cliente novamente em vez de devolver erro ao usuário.
 */
export async function findOrCreateAsaasCustomer(
  input: FindOrCreateCustomerInput
): Promise<AsaasCustomer> {
  const email = input.email.trim();
  const cpfCnpj = onlyDigits(input.cpfCnpj);
  const phone = onlyDigits(input.phone);

  if (email) {
    const byEmail = await findCustomerBy({ email });
    if (byEmail) return byEmail;
  }

  if (cpfCnpj) {
    const byCpfCnpj = await findCustomerBy({ cpfCnpj });
    if (byCpfCnpj) return byCpfCnpj;
  }

  try {
    return await asaasRequest<AsaasCustomer>("/customers", {
      method: "POST",
      body: {
        name: input.name.trim(),
        email,
        cpfCnpj,
        phone,
        ...(phone.length === 11 ? { mobilePhone: phone } : {}),
        externalReference: input.externalReference,
      },
    });
  } catch (error) {
    if (
      error instanceof AsaasError &&
      /já existe|already exists|duplicad/i.test(error.message)
    ) {
      const existing =
        (cpfCnpj ? await findCustomerBy({ cpfCnpj }) : null) ??
        (email ? await findCustomerBy({ email }) : null);

      if (existing) return existing;
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Assinaturas
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  customerId: string;
  billingType: BillingType;
  /** Valor mensal em reais (ex.: 97). */
  value: number;
  /** Primeiro vencimento no formato `YYYY-MM-DD`. */
  nextDueDate: string;
  description?: string;
  externalReference?: string;
  /** Obrigatório quando `billingType === "CREDIT_CARD"`. */
  creditCard?: {
    holderName: string;
    number: string;
    expiryMonth: string;
    expiryYear: string;
    ccv: string;
  };
  /** Obrigatório quando `billingType === "CREDIT_CARD"`. */
  creditCardHolderInfo?: {
    name: string;
    email: string;
    cpfCnpj: string;
    postalCode: string;
    addressNumber: string;
    phone?: string;
  };
  /** IP do comprador — exigido pelo antifraude do cartão. */
  remoteIp?: string;
}

/**
 * Cria a assinatura mensal recorrente no Asaas.
 *
 * Pix e boleto são gerados automaticamente pelo Asaas a cada ciclo; no cartão
 * o próprio Asaas reexecuta a cobrança. A primeira cobrança nasce para
 * `nextDueDate` (hoje, no fluxo do checkout).
 *
 * A documentação separa o endpoint de cartão (`POST /subscriptions/`) do
 * genérico (`POST /subscriptions`), por isso a barra final condicional.
 */
export async function createAsaasSubscription(
  input: CreateSubscriptionInput
): Promise<AsaasSubscription> {
  const body: Record<string, unknown> = {
    customer: input.customerId,
    billingType: input.billingType,
    value: Number(input.value.toFixed(2)),
    nextDueDate: input.nextDueDate,
    cycle: "MONTHLY",
    description: input.description,
    externalReference: input.externalReference,
  };

  let path = "/subscriptions";

  if (input.billingType === "CREDIT_CARD") {
    if (!input.creditCard || !input.creditCardHolderInfo) {
      throw new AsaasError(
        "Dados do cartão de crédito são obrigatórios.",
        400,
        "missing_credit_card"
      );
    }

    body.creditCard = {
      holderName: input.creditCard.holderName.trim(),
      number: onlyDigits(input.creditCard.number),
      expiryMonth: input.creditCard.expiryMonth.padStart(2, "0"),
      expiryYear: input.creditCard.expiryYear,
      ccv: onlyDigits(input.creditCard.ccv),
    };
    body.creditCardHolderInfo = {
      name: input.creditCardHolderInfo.name.trim(),
      email: input.creditCardHolderInfo.email.trim(),
      cpfCnpj: onlyDigits(input.creditCardHolderInfo.cpfCnpj),
      postalCode: onlyDigits(input.creditCardHolderInfo.postalCode),
      addressNumber: input.creditCardHolderInfo.addressNumber.trim(),
      ...(input.creditCardHolderInfo.phone
        ? { phone: onlyDigits(input.creditCardHolderInfo.phone) }
        : {}),
    };
    if (input.remoteIp) body.remoteIp = input.remoteIp;

    path = "/subscriptions/";
  }

  return asaasRequest<AsaasSubscription>(path, { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Cobranças
// ---------------------------------------------------------------------------

/**
 * Lista as cobranças já geradas por uma assinatura (mais antigas e mais
 * recentes). Cobranças futuras ainda não geradas não aparecem.
 */
export async function listSubscriptionPayments(
  subscriptionId: string
): Promise<AsaasPayment[]> {
  const list = await asaasRequest<AsaasListResponse<AsaasPayment>>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=100`
  );

  return list.data ?? [];
}

/** Recupera uma cobrança pelo ID (usado como fallback no polling). */
export async function getAsaasPayment(
  paymentId: string
): Promise<AsaasPayment> {
  return asaasRequest<AsaasPayment>(
    `/payments/${encodeURIComponent(paymentId)}`
  );
}

/** QR Code dinâmico (imagem Base64 + Pix Copia e Cola) de uma cobrança. */
export async function getPixQrCode(
  paymentId: string
): Promise<AsaasPixQrCode> {
  return asaasRequest<AsaasPixQrCode>(
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`
  );
}


