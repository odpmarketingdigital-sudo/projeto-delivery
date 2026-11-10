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
 *  - `DELETE /subscriptions/{id}`                   → cancela (remove) a assinatura;
 *  - `GET  /payments/{id}/pixQrCode`                → QR Code dinâmico do Pix.
 *
 * Docs: https://docs.asaas.com/reference
 */

import { onlyDigits, type BillingType } from "./billing";
import type { AsaasSubscriptionCycle } from "./subscriptions";

/** URL do Sandbox (usada quando `ASAAS_API_URL`/`ASAAS_ENV` não definem nada). */
const SANDBOX_API_URL = "https://sandbox.asaas.com/api/v3";

/** URL de Produção. */
const PRODUCTION_API_URL = "https://api.asaas.com/v3";

/** O Asaas recomenda timeout mínimo de 60s na criação de assinaturas. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Causas prováveis de 401/403 — o Asaas normalmente responde esses status sem
 * `errors[]` detalhado (bloqueio de WAF/IP, chave de outro ambiente ou conta
 * sem permissão para subcontas).
 */
const AUTH_ERROR_HINT =
  "Verifique se a API key é válida e pertence ao MESMO ambiente da " +
  "ASAAS_API_URL (sandbox ou produção), se ela tem permissão para subcontas " +
  "e se o IP do servidor está liberado no painel do Asaas.";

/** Ambiente do Asaas em uso (a API key é diferente em cada um). */
export type AsaasEnvironment = "sandbox" | "production";

/** Rótulo em português usado nas mensagens de erro. */
function environmentLabel(environment: AsaasEnvironment): string {
  return environment === "sandbox" ? "Sandbox" : "Produção";
}

/**
 * Normaliza a base informada em `ASAAS_API_URL`.
 *
 * Aceita a URL completa (`https://api.asaas.com/v3`), com barra no final ou
 * sem o segmento de versão (`https://api.asaas.com`) — o Asaas exige `/v3`
 * (ou `/api/v3`) no path, então completamos quando estiver ausente.
 */
function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return SANDBOX_API_URL;
  return /\/(?:api\/)?v3$/i.test(trimmed) ? trimmed : `${trimmed}/v3`;
}

/**
 * Base da API do Asaas lida em tempo de execução.
 *
 * Precedência:
 *  1. `ASAAS_API_URL` — URL completa da API (sandbox ou produção);
 *  2. `ASAAS_ENV` — `production`/`prod` usa a API de produção;
 *  3. Sandbox (padrão de desenvolvimento).
 */
export function getAsaasBaseUrl(): string {
  const configured = process.env.ASAAS_API_URL?.trim();
  if (configured) return normalizeApiUrl(configured);

  const environment = process.env.ASAAS_ENV?.trim().toLowerCase();
  if (environment === "production" || environment === "prod") {
    return PRODUCTION_API_URL;
  }

  return SANDBOX_API_URL;
}

/** Ambiente inferido da base configurada (usado nos diagnósticos de erro). */
export function getAsaasEnvironment(): AsaasEnvironment {
  return /sandbox/i.test(getAsaasBaseUrl()) ? "sandbox" : "production";
}

/** Diagnóstico do ambiente devolvido nas respostas de erro da API interna. */
export function describeAsaasEnvironment(): {
  environment: AsaasEnvironment;
  label: string;
  baseUrl: string;
} {
  const environment = getAsaasEnvironment();
  return {
    environment,
    label: environmentLabel(environment),
    baseUrl: getAsaasBaseUrl(),
  };
}

/** Detalhe de erro devolvido pelo Asaas (`errors[]`). */
export interface AsaasErrorDetail {
  code?: string;
  description?: string;
}

/** Diagnóstico da chamada que falhou (nunca inclui a API key). */
export interface AsaasRequestContext {
  method: "GET" | "POST" | "DELETE";
  /** Endpoint chamado, com query string (ex.: `/accounts`). */
  endpoint: string;
  /** Base da API usada (sandbox ou produção). */
  base_url: string;
  environment: AsaasEnvironment;
  /** `true` quando a chamada usou a credencial de uma subconta. */
  subaccount: boolean;
  /** HTTP devolvido pelo Asaas (quando houve resposta). */
  gateway_status?: number;
}

/** Erro normalizado da API do Asaas (nunca expõe a API key). */
export class AsaasError extends Error {
  /** Status HTTP devolvido pelo Asaas (ou 500/502 quando local). */
  readonly status: number;
  /** Código do erro no Asaas (ex.: `invalid_cpfCnpj`). */
  readonly code: string | null;
  /** Corpo devolvido pelo Asaas (ex.: `{ errors: [{ code, description }] }`). */
  readonly details: unknown;
  /** Diagnóstico da chamada (ambiente, endpoint e credencial usada). */
  readonly request: AsaasRequestContext | null;

  constructor(
    message: string,
    status = 502,
    code: string | null = null,
    context: { details?: unknown; request?: AsaasRequestContext } = {}
  ) {
    super(message);
    this.name = "AsaasError";
    this.status = status;
    this.code = code;
    this.details = context.details ?? null;
    this.request = context.request ?? null;
  }
}

/** Falha do gateway já normalizada para o JSON das rotas internas. */
export interface AsaasFailure {
  /** Mensagem pronta para exibir ao usuário. */
  message: string;
  /** HTTP que a rota interna deve devolver. */
  status: number;
  code: string | null;
  /** Corpo detalhado devolvido pelo Asaas (ex.: `errors[]`). */
  details: unknown;
  /** Diagnóstico da chamada (ambiente, endpoint e credencial usada). */
  context: AsaasRequestContext | null;
}

/**
 * Converte qualquer falha do gateway em um objeto serializável.
 *
 * Usado pelas rotas internas para devolver `details`/`asaas_status`/
 * `asaas_environment` no JSON — é o que permite distinguir API key inválida,
 * divergência sandbox × produção e restrição de permissão/IP no 403.
 */
export function describeAsaasFailure(
  error: unknown,
  fallbackMessage = "Não foi possível conectar ao Asaas.",
  fallbackStatus = 502
): AsaasFailure {
  if (error instanceof AsaasError) {
    return {
      message: error.message,
      status: error.status >= 400 && error.status < 600 ? error.status : 502,
      code: error.code,
      details: error.details,
      context: error.request,
    };
  }

  return {
    message: fallbackMessage,
    status: fallbackStatus,
    code: null,
    details: null,
    context: null,
  };
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
  /** Referência livre gravada na criação (usamos o id do pedido). */
  externalReference?: string | null;
}

interface AsaasListResponse<T> {
  object: "list";
  hasMore: boolean;
  totalCount: number;
  limit?: number;
  offset?: number;
  data: T[];
}

/**
 * Credencial opcional por chamada.
 *
 * Sem `apiKey` a requisição usa a chave da plataforma (`ASAAS_API_KEY`); com
 * `apiKey` usa a credencial da subconta do lojista (cobranças com Split).
 */
export interface AsaasRequestOptions {
  apiKey?: string;
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

/**
 * Configuração lida em tempo de execução (erro claro quando ausente).
 *
 * `apiKeyOverride` permite chamar o Asaas com a credencial de uma SUBCONTA
 * (Split): cada lojista tem a própria API key, devolvida na criação da
 * subconta e guardada em `establishments.asaas_api_key`.
 */
function getConfig(apiKeyOverride?: string): { apiKey: string; baseUrl: string } {
  const apiKey = apiKeyOverride?.trim() || process.env.ASAAS_API_KEY?.trim();
  if (!apiKey) {
    throw new AsaasError(
      "Pagamento indisponível: ASAAS_API_KEY não configurada no servidor.",
      500,
      "missing_api_key"
    );
  }

  // `ASAAS_API_URL` (ou `ASAAS_ENV`) define sandbox × produção — a base não
  // pode ficar hardcoded, senão a chave de produção é recusada no sandbox.
  return { apiKey, baseUrl: getAsaasBaseUrl() };
}

/** `true` quando o Asaas está configurado (usado por diagnósticos). */
export function isAsaasConfigured(): boolean {
  return Boolean(process.env.ASAAS_API_KEY?.trim());
}

interface AsaasErrorBody {
  /** Lista de erros de validação/negócio do Asaas. */
  errors?: AsaasErrorDetail[];
  /** Mensagem simples (algumas respostas de bloqueio usam este campo). */
  message?: string;
}

/** Recorta corpos longos (HTML de proxy/WAF) para caber no log e no JSON. */
function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Monta a mensagem para o usuário a partir da resposta de erro do Asaas.
 *
 * Erros de negócio vêm em `errors[]`; já 401/403 costumam vir sem detalhe
 * (ou em HTML, quando há bloqueio de WAF/IP). Nesses casos anexamos as causas
 * prováveis — API key, ambiente (sandbox × produção) e permissão.
 */
function buildAsaasErrorMessage(
  status: number,
  errors: AsaasErrorDetail[],
  fallback?: string
): string {
  const descriptions = errors
    .map((item) => item.description?.trim())
    .filter((item): item is string => Boolean(item));

  const primary =
    descriptions[0] ||
    fallback?.trim() ||
    `O Asaas recusou a operação (HTTP ${status}).`;

  // Demais detalhes (o Asaas pode devolver vários erros na mesma resposta).
  const extra =
    descriptions.length > 1 ? ` (${descriptions.slice(1).join("; ")})` : "";

  if (status === 401 || status === 403) {
    return `${primary}${extra} ${AUTH_ERROR_HINT}`;
  }

  return `${primary}${extra}`;
}

/**
 * Executa uma requisição autenticada e devolve o JSON tipado.
 * Todo erro vira `AsaasError` com a descrição em português do Asaas.
 */
async function asaasRequest<T>(
  path: string,
  init: {
    method: "GET" | "POST" | "DELETE";
    body?: unknown;
    /** Credencial da subconta (Split). Ausente = conta principal. */
    apiKey?: string;
  } = { method: "GET" }
): Promise<T> {
  const { apiKey, baseUrl } = getConfig(init.apiKey);

  /**
   * Diagnóstico anexado a qualquer falha — nunca inclui a API key. É o que
   * permite distinguir, no 403, chave inválida de ambiente divergente e de
   * restrição de permissão/IP.
   */
  const context: AsaasRequestContext = {
    method: init.method,
    endpoint: path,
    base_url: baseUrl,
    environment: getAsaasEnvironment(),
    subaccount: Boolean(init.apiKey?.trim()),
  };

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
        "gateway_timeout",
        { request: context }
      );
    }
    throw new AsaasError(
      "Não foi possível conectar ao Asaas. Verifique a conexão do servidor.",
      502,
      "gateway_unreachable",
      { request: context }
    );
  } finally {
    clearTimeout(timeout);
  }

  // Lê como texto para preservar respostas não-JSON (HTML de WAF/proxy).
  const rawBody = await response.text().catch(() => "");
  let payload: (T & AsaasErrorBody) | null = null;
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody) as T & AsaasErrorBody;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const apiErrors = payload?.errors ?? [];
    const firstError = apiErrors[0];
    // Sem JSON: guarda um trecho do corpo bruto (identifica bloqueio de WAF).
    const details: unknown =
      payload ?? (rawBody ? { raw: truncate(rawBody) } : null);

    context.gateway_status = response.status;

    // Corpo completo do Asaas no log do servidor — necessário para saber se o
    // 403 é API key inválida, ambiente divergente (sandbox × produção) ou
    // permissão/IP bloqueado.
    console.error(
      `[asaas] ${init.method} ${path} falhou (HTTP ${response.status}, ` +
        `${environmentLabel(context.environment)})`,
      {
        base_url: baseUrl,
        subaccount: context.subaccount,
        code: firstError?.code ?? null,
        errors: apiErrors,
        details,
      }
    );

    throw new AsaasError(
      buildAsaasErrorMessage(response.status, apiErrors, payload?.message),
      response.status,
      firstError?.code ?? null,
      { details, request: context }
    );
  }

  if (!payload) {
    // `DELETE` pode responder 204 (sem corpo): não é erro — o Asaas normalmente
    // devolve `{ deleted: true, id }`, mas o corpo vazio também é sucesso.
    if (response.status === 204) return {} as T;

    throw new AsaasError(
      "O Asaas devolveu uma resposta inválida.",
      502,
      "invalid_response",
      {
        details: rawBody ? { raw: truncate(rawBody) } : null,
        request: context,
      }
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
  /** E-mail do cliente (opcional — o Asaas aceita cliente sem e-mail). */
  email?: string;
  /** CPF ou CNPJ (com ou sem máscara). */
  cpfCnpj: string;
  /** Telefone com DDD (com ou sem máscara). */
  phone: string;
  /** Identificador da loja no nosso banco (rastreabilidade). */
  externalReference?: string;
}

/** Busca um cliente por e-mail ou CPF/CNPJ (1º resultado). */
async function findCustomerBy(
  params: { email?: string; cpfCnpj?: string },
  options: AsaasRequestOptions = {}
): Promise<AsaasCustomer | null> {
  const query = new URLSearchParams({ limit: "1" });
  if (params.email) query.set("email", params.email);
  if (params.cpfCnpj) query.set("cpfCnpj", params.cpfCnpj);

  const list = await asaasRequest<AsaasListResponse<AsaasCustomer>>(
    `/customers?${query.toString()}`,
    { method: "GET", apiKey: options.apiKey }
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
  input: FindOrCreateCustomerInput,
  options: AsaasRequestOptions = {}
): Promise<AsaasCustomer> {
  const email = input.email?.trim() ?? "";
  const cpfCnpj = onlyDigits(input.cpfCnpj);
  const phone = onlyDigits(input.phone);

  if (email) {
    const byEmail = await findCustomerBy({ email }, options);
    if (byEmail) return byEmail;
  }

  if (cpfCnpj) {
    const byCpfCnpj = await findCustomerBy({ cpfCnpj }, options);
    if (byCpfCnpj) return byCpfCnpj;
  }

  try {
    return await asaasRequest<AsaasCustomer>("/customers", {
      method: "POST",
      apiKey: options.apiKey,
      body: {
        name: input.name.trim(),
        // O e-mail é opcional no Asaas: omitimos quando vazio para não enviar
        // string vazia (o gateway recusa valores em branco).
        ...(email ? { email } : {}),
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
        (cpfCnpj ? await findCustomerBy({ cpfCnpj }, options) : null) ??
        (email ? await findCustomerBy({ email }, options) : null);

      if (existing) return existing;
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Subcontas (Split de pagamentos)
// ---------------------------------------------------------------------------

/** Campos aceitos pelo Asaas na criação de uma subconta. */
export interface CreateAsaasSubaccountInput {
  /** Razão social (PJ) ou nome completo (PF). */
  name: string;
  email: string;
  /** CPF (11) ou CNPJ (14) — dígitos ou com máscara. */
  cpfCnpj: string;
  /** Celular com DDD (obrigatório no Asaas como `mobilePhone`). */
  mobilePhone: string;
  /** Telefone fixo (opcional). */
  phone?: string;
  /** Faturamento/renda mensal em reais. */
  incomeValue: number;
  /** Logradouro. */
  address: string;
  addressNumber: string;
  /** Complemento (opcional). */
  complement?: string;
  /** Bairro. */
  province: string;
  /** CEP (com ou sem máscara). */
  postalCode: string;
  /** Obrigatório para pessoa jurídica (CNPJ). */
  companyType?: "MEI" | "LIMITED" | "INDIVIDUAL" | "ASSOCIATION";
  /** Obrigatório para pessoa física (CPF), formato `YYYY-MM-DD`. */
  birthDate?: string;
}

/**
 * Subconta retornada pelo Asaas.
 *
 * Docs: <https://docs.asaas.com/reference/criar-subconta> (POST /accounts) e
 * <https://docs.asaas.com/reference/recuperar-uma-unica-subconta> (GET).
 */
export interface AsaasSubaccount {
  id: string;
  /** Carteira da subconta — destino dos splits. */
  walletId?: string | null;
  name?: string | null;
  email?: string | null;
  cpfCnpj?: string | null;
  /** Presente apenas na criação; não é recuperável depois. */
  apiKey?: string | null;
  /** O Asaas devolve a chave dentro de `accessToken.apiKey`. */
  accessToken?: { apiKey?: string | null } | null;
}

/**
 * Cria uma subconta vinculada à conta-mãe (chamada com a API key da
 * plataforma). O Asaas exige a conta-mãe como pessoa jurídica (CNPJ).
 *
 * Docs: POST /accounts — <https://docs.asaas.com/reference/criar-subconta>
 */
export async function createAsaasSubaccount(
  input: CreateAsaasSubaccountInput
): Promise<AsaasSubaccount> {
  const mobilePhone = onlyDigits(input.mobilePhone);
  const phone = input.phone ? onlyDigits(input.phone) : "";
  const body: Record<string, unknown> = {
    name: input.name.trim(),
    email: input.email.trim(),
    cpfCnpj: onlyDigits(input.cpfCnpj),
    mobilePhone,
    incomeValue: input.incomeValue,
    address: input.address.trim(),
    addressNumber: input.addressNumber.trim(),
    province: input.province.trim(),
    postalCode: onlyDigits(input.postalCode),
  };

  if (phone) body.phone = phone;
  if (input.complement?.trim()) body.complement = input.complement.trim();
  if (input.companyType) body.companyType = input.companyType;
  if (input.birthDate) body.birthDate = input.birthDate;

  return asaasRequest<AsaasSubaccount>("/accounts", {
    method: "POST",
    body,
  });
}

/** Recupera uma subconta pelo ID. Docs: GET /accounts/{id}. */
export async function getAsaasSubaccount(
  accountId: string
): Promise<AsaasSubaccount> {
  return asaasRequest<AsaasSubaccount>(
    `/accounts/${encodeURIComponent(accountId)}`
  );
}

/**
 * Busca uma subconta pelo CPF/CNPJ. Usada para reaproveitar a subconta quando
 * uma tentativa de criação falha por duplicidade (mesmo documento).
 */
export async function findAsaasSubaccountByCpfCnpj(
  cpfCnpj: string
): Promise<AsaasSubaccount | null> {
  const digits = onlyDigits(cpfCnpj);
  if (!digits) return null;
  const query = new URLSearchParams({ cpfCnpj: digits, limit: "1" });
  const list = await asaasRequest<AsaasListResponse<AsaasSubaccount>>(
    `/accounts?${query.toString()}`
  );
  return list.data?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Assinaturas
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  customerId: string;
  billingType: BillingType;
  /**
   * Valor cobrado em cada ciclo, em reais (ex.: 97 no mensal, 553 no
   * semestral com 5% de desconto, 1047,60 no anual com 10%).
   */
  value: number;
  /** Primeiro vencimento no formato `YYYY-MM-DD`. */
  nextDueDate: string;
  /** Ciclo de cobrança da assinatura (padrão `MONTHLY`). */
  cycle?: AsaasSubscriptionCycle;
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
 * Cria a assinatura recorrente no Asaas.
 *
 * Pix e boleto são gerados automaticamente pelo Asaas a cada ciclo; no cartão
 * o próprio Asaas reexecuta a cobrança. A primeira cobrança nasce para
 * `nextDueDate` (hoje, no fluxo do checkout).
 *
 * `cycle` define a periodicidade (`MONTHLY`, `SEMIANNUAL` ou `YEARLY`) e
 * `value` é o total cobrado em cada ciclo — que já inclui o desconto do ciclo
 * (5% semestral / 10% anual) e o eventual cupom aplicado no checkout.
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
    cycle: input.cycle ?? "MONTHLY",
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

/**
 * Recupera uma assinatura pelo ID.
 *
 * Usado pela tela de assinatura (`GET /api/billing/status`) para exibir o ciclo
 * contratado (`cycle`) e a próxima renovação (`nextDueDate`) direto da fonte,
 * inclusive para lojas contratadas antes das colunas de ciclo existirem.
 */
export async function getAsaasSubscription(
  subscriptionId: string
): Promise<AsaasSubscription> {
  return asaasRequest<AsaasSubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`
  );
}

/** Retorno de `DELETE /subscriptions/{id}`. */
export interface AsaasDeletedSubscription {
  /** `true` quando o Asaas confirmou a remoção. */
  deleted: boolean;
  id: string;
}

/**
 * Cancela (remove) a assinatura no Asaas — `DELETE /subscriptions/{id}`.
 *
 * É o endpoint oficial de cancelamento: interrompe as PRÓXIMAS cobranças (nada
 * novo é faturado) sem estornar o período já pago. Assinatura inexistente
 * responde 404 no Asaas, tratado pela rota de cancelamento como "já cancelada".
 *
 * O Asaas devolve `{ deleted: true, id }`; quando responde 204 (sem corpo),
 * devolvemos o mesmo formato para quem consome não depender do payload.
 */
export async function deleteAsaasSubscription(
  subscriptionId: string
): Promise<AsaasDeletedSubscription> {
  const result = await asaasRequest<Partial<AsaasDeletedSubscription>>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE" }
  );

  return { deleted: result.deleted ?? true, id: result.id ?? subscriptionId };
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
  paymentId: string,
  options: AsaasRequestOptions = {}
): Promise<AsaasPayment> {
  return asaasRequest<AsaasPayment>(
    `/payments/${encodeURIComponent(paymentId)}`,
    { method: "GET", apiKey: options.apiKey }
  );
}

/** QR Code dinâmico (imagem Base64 + Pix Copia e Cola) de uma cobrança. */
export async function getPixQrCode(
  paymentId: string,
  options: AsaasRequestOptions = {}
): Promise<AsaasPixQrCode> {
  return asaasRequest<AsaasPixQrCode>(
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
    { method: "GET", apiKey: options.apiKey }
  );
}

/**
 * Remove uma cobrança no Asaas (`DELETE /payments/{id}`).
 *
 * Usado quando o QR Code expira e o checkout gera uma nova cobrança para o
 * mesmo pedido — evita dois QR Codes pagáveis para o mesmo valor.
 */
export async function deleteAsaasPayment(
  paymentId: string,
  options: AsaasRequestOptions = {}
): Promise<{ deleted: boolean; id: string }> {
  const result = await asaasRequest<{ deleted?: boolean; id?: string }>(
    `/payments/${encodeURIComponent(paymentId)}`,
    { method: "DELETE", apiKey: options.apiKey }
  );
  return { deleted: result.deleted ?? true, id: result.id ?? paymentId };
}

// ---------------------------------------------------------------------------
// Cobranças PIX com Split (checkout da vitrine)
// ---------------------------------------------------------------------------

/**
 * Destinatário de um Split de pagamento.
 *
 * O saldo que não for destinado a nenhum recebedor permanece na conta que
 * emitiu a cobrança. Regras do Asaas:
 *  - NUNCA use o `walletId` da própria conta emissora como destino;
 *  - `fixedValue`/`percentualValue` são validados sobre o `netValue`
 *    (valor da cobrança menos as taxas do gateway) e a soma não pode
 *    ultrapassá-lo.
 *
 * Por isso a cobrança do pedido é criada com a credencial da SUBCONTA do
 * lojista (o restante fica lá) e o Split envia apenas a taxa fixa da
 * plataforma para a carteira da Ipepper.
 *
 * Docs: <https://docs.asaas.com/docs/split-em-cobrancas-avulsas>
 */
export interface AsaasPaymentSplit {
  walletId: string;
  /** Valor fixo, em reais, repassado ao recebedor. */
  fixedValue?: number;
  /** Percentual (0–100) calculado sobre o `netValue`. */
  percentualValue?: number;
}

/** Campos aceitos na criação de uma cobrança avulsa (POST /v3/payments). */
export interface CreateAsaasPaymentInput {
  /** Cliente do Asaas dono da cobrança (criado na mesma conta emissora). */
  customerId: string;
  /** Valor total, em reais. */
  value: number;
  /** Vencimento (`YYYY-MM-DD`) no fuso de Brasília. */
  dueDate: string;
  description?: string;
  /** Referência livre — usada pelo webhook para achar o pedido. */
  externalReference?: string;
  split?: AsaasPaymentSplit[];
}

/**
 * Cria uma cobrança PIX no Asaas (POST /v3/payments).
 *
 * `options.apiKey` deve ser a credencial da SUBCONTA do lojista no fluxo de
 * Split (assim o saldo restante fica com ele). Sem `apiKey` a cobrança é
 * criada na conta principal.
 *
 * O QR Code/Copia e Cola NÃO vem nesta resposta: consulte
 * `GET /payments/{id}/pixQrCode` (`getPixQrCode`).
 */
export async function createAsaasPixPayment(
  input: CreateAsaasPaymentInput,
  options: AsaasRequestOptions = {}
): Promise<AsaasPayment> {
  const split = (input.split ?? [])
    .filter(
      (item) =>
        typeof item.walletId === "string" &&
        item.walletId.trim() !== "" &&
        ((typeof item.fixedValue === "number" && item.fixedValue > 0) ||
          (typeof item.percentualValue === "number" && item.percentualValue > 0))
    )
    .map((item) => ({
      walletId: item.walletId.trim(),
      ...(typeof item.fixedValue === "number" && item.fixedValue > 0
        ? { fixedValue: Number(item.fixedValue.toFixed(2)) }
        : {}),
      ...(typeof item.percentualValue === "number" && item.percentualValue > 0
        ? { percentualValue: Number(item.percentualValue.toFixed(2)) }
        : {}),
    }));

  const body: Record<string, unknown> = {
    customer: input.customerId,
    billingType: "PIX",
    value: Number(input.value.toFixed(2)),
    dueDate: input.dueDate,
    ...(input.description ? { description: input.description } : {}),
    ...(input.externalReference
      ? { externalReference: input.externalReference }
      : {}),
    ...(split.length > 0 ? { split } : {}),
  };

  return asaasRequest<AsaasPayment>("/payments", {
    method: "POST",
    apiKey: options.apiKey,
    body,
  });
}

// ---------------------------------------------------------------------------
// Webhooks da subconta (eventos das cobranças emitidas por ela)
// ---------------------------------------------------------------------------

/** Webhook configurado no Asaas (campos usados para evitar duplicidade). */
export interface AsaasWebhook {
  id: string;
  url?: string | null;
  enabled?: boolean | null;
  authToken?: string | null;
}

export interface EnsureAsaasWebhookInput {
  /** URL pública do endpoint (HTTPS). */
  url: string;
  /** E-mail que recebe alertas de falha de entrega. */
  email: string;
  /** Token enviado no header `asaas-access-token`. */
  authToken?: string;
}

/**
 * Garante que a SUBCONTA envie os eventos para o endpoint da plataforma.
 *
 * Cada subconta tem a própria configuração de webhook — sem isso as cobranças
 * emitidas dentro dela não chegam ao `/api/asaas/webhook`. A operação é
 * idempotente (não duplica quando já existe um webhook com a mesma URL) e
 * best-effort: o chamador deve ignorar falhas para não bloquear a conexão do
 * recebimento online.
 */
export async function ensureAsaasWebhook(
  input: EnsureAsaasWebhookInput,
  options: AsaasRequestOptions = {}
): Promise<{ created: boolean }> {
  const target = input.url.trim().replace(/\/+$/, "");
  if (!target) return { created: false };

  const list = await asaasRequest<AsaasListResponse<AsaasWebhook>>(
    "/webhooks?limit=100",
    { method: "GET", apiKey: options.apiKey }
  );

  const exists = (list.data ?? []).some(
    (item) => (item.url ?? "").trim().replace(/\/+$/, "") === target
  );
  if (exists) return { created: false };

  await asaasRequest<AsaasWebhook>("/webhooks", {
    method: "POST",
    apiKey: options.apiKey,
    body: {
      name: "Ipepper Pedidos",
      url: target,
      email: input.email.trim(),
      enabled: true,
      interrupted: false,
      apiVersion: "v3",
      ...(input.authToken ? { authToken: input.authToken } : {}),
    },
  });

  return { created: true };
}


