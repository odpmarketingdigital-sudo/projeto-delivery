/**
 * Contrato do Extrato de Pagamentos (`/painel/financeiro`).
 *
 * Módulo isomórfico (sem APIs de servidor/navegador): a rota
 * `GET /api/financeiro` monta o extrato com estas regras e a tela do painel
 * reutiliza os mesmos tipos, rótulos e cores para exibi-lo.
 *
 * Regra do Split (Asaas): cada pedido **pago** online gera uma taxa fixa de
 * R$ 0,50 retida pela plataforma no repasse — o líquido do lojista é o valor
 * bruto menos essa taxa. Pedidos pendentes/expirados/cancelados não geram taxa
 * nem repasse (o dinheiro ainda não entrou na subconta).
 */

import { PLATFORM_FEE_CENTS } from "./asaasSubaccount";

/** Taxa da plataforma por pedido pago online, em reais (ex.: 0.5 = R$ 0,50). */
export const PLATFORM_FEE_REAIS = PLATFORM_FEE_CENTS / 100;

/** Forma de pagamento online aceita no extrato (`orders.payment_method`). */
export const ONLINE_PAYMENT_METHOD = "pix_online";

/**
 * Situações do pagamento online (`orders.payment_status`, migração
 * 20261110000028). Pedidos pagos na entrega permanecem `pendente` e não
 * entram no extrato (só pedidos com pagamento online).
 */
export const PAYMENT_STATEMENT_STATUSES = [
  "pago",
  "pendente",
  "expirado",
  "cancelado",
] as const;

export type PaymentStatementStatus =
  (typeof PAYMENT_STATEMENT_STATUSES)[number];

/**
 * Normaliza o status vindo do banco/edge para o conjunto conhecido.
 * Valores fora do fluxo (bases legadas, webhooks novos do gateway) contam
 * como `pendente` — nunca como pago.
 */
export function normalizePaymentStatementStatus(
  value: unknown
): PaymentStatementStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (PAYMENT_STATEMENT_STATUSES as readonly string[]).includes(raw)
    ? (raw as PaymentStatementStatus)
    : "pendente";
}

/** Metadados visuais de uma situação de pagamento no extrato. */
export interface PaymentStatusMeta {
  label: string;
  /** Classes do badge (fundo/texto/anel) no tema claro do painel. */
  badgeClass: string;
  /** Cor do ponto indicador. */
  dotClass: string;
  /** Situação do recebimento/repasse na subconta do lojista. */
  settlementLabel: string;
}

export const PAYMENT_STATUS_META: Record<
  PaymentStatementStatus,
  PaymentStatusMeta
> = {
  pago: {
    label: "Pago ✓",
    badgeClass: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    dotClass: "bg-emerald-500",
    settlementLabel: "Recebido na Subconta",
  },
  pendente: {
    label: "Pendente ⏳",
    badgeClass: "bg-amber-100 text-amber-700 ring-amber-200",
    dotClass: "bg-yellow-400",
    settlementLabel: "Aguardando pagamento",
  },
  expirado: {
    label: "Expirado",
    badgeClass: "bg-slate-100 text-slate-600 ring-slate-200",
    dotClass: "bg-slate-400",
    settlementLabel: "QR Code expirado",
  },
  cancelado: {
    label: "Cancelado",
    badgeClass: "bg-red-100 text-red-700 ring-red-200",
    dotClass: "bg-red-500",
    settlementLabel: "Cobrança cancelada",
  },
};

/** Linha do extrato: um pedido com pagamento online. */
export interface PaymentStatementEntry {
  id: string;
  /** Número curto exibido no painel (#0001…), derivado da ordem cronológica. */
  shortNumber: string;
  created_at: string;
  /** Momento da confirmação do pagamento (`payment_confirmed_at`). */
  paid_at: string | null;
  customer_name: string;
  /** Telefone somente com dígitos (como salvo em `orders.customer_phone`). */
  customer_phone: string | null;
  payment_method: string;
  status: PaymentStatementStatus;
  /** Valor bruto do pedido (reais). */
  gross: number;
  /** Taxa da plataforma retida no repasse (0 quando o pedido não está pago). */
  fee: number;
  /** Valor líquido do lojista (bruto − taxa; 0 quando não está pago). */
  net: number;
  /** true = pagamento confirmado (taxa e líquido são definitivos). */
  settled: boolean;
}

/** Resumo do extrato no mês corrente (fuso da loja). */
export interface PaymentStatementSummary {
  /** Mês de referência no fuso da loja, no formato YYYY-MM. */
  month: string;
  /** Pedidos pagos no mês. */
  paidOrders: number;
  /** Pedidos ainda aguardando pagamento no mês. */
  pendingOrders: number;
  /** Total vendido online no mês (soma do bruto dos pedidos pagos). */
  grossTotal: number;
  /** Taxas da plataforma no mês (R$ 0,50 × pedidos pagos). */
  feeTotal: number;
  /** Saldo líquido repassado ao lojista no mês. */
  netTotal: number;
}

/** Payload do `GET /api/financeiro`. */
export interface PaymentStatement {
  summary: PaymentStatementSummary;
  /** Pedidos com pagamento online, do mais recente para o mais antigo. */
  orders: PaymentStatementEntry[];
  /** Total de pedidos online da loja (sem recorte de período). */
  totalOrders: number;
}

/** Filtro de status da tabela (`todos` = sem recorte). */
export type PaymentStatementFilter = "todos" | PaymentStatementStatus;

/** Opções do seletor de status da tela (ordem de exibição). */
export const PAYMENT_STATEMENT_FILTERS: {
  value: PaymentStatementFilter;
  label: string;
}[] = [
  { value: "todos", label: "Todos" },
  { value: "pago", label: "Pagos" },
  { value: "pendente", label: "Pendentes" },
];
