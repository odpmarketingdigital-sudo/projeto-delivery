import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import { currentMonthValue, monthRange } from "@/lib/dateRange";
import {
  ONLINE_PAYMENT_METHOD,
  PLATFORM_FEE_REAIS,
  normalizePaymentStatementStatus,
  type PaymentStatement,
  type PaymentStatementEntry,
} from "@/lib/finance";

/**
 * GET /api/financeiro?establishment_id=xxx
 *
 * Extrato de Pagamentos da loja: todos os pedidos com pagamento **online**
 * (PIX Online do Split Asaas), com valor bruto, taxa da plataforma (R$ 0,50 por
 * pedido pago), líquido do lojista e situação do repasse.
 *
 * O resumo (cards do topo) é fechado no mês corrente do fuso da loja; a lista
 * devolve todo o histórico de pedidos online, do mais recente para o mais
 * antigo. A taxa só é debitada quando o pagamento é confirmado — pedidos
 * pendentes/expirados/cancelados aparecem com taxa e líquido zerados.
 *
 * Segurança: exige sessão; o `admin` só lê o próprio estabelecimento e o
 * `super_admin` qualquer um (deep-link `?establishment_id=`) — as mesmas
 * regras de `/api/dashboard` e `/api/customers/history`.
 */

/** Linha crua de `orders` (colunas novas podem faltar em bases legadas). */
type OrderRow = Record<string, unknown>;

/** Erro do PostgREST (só os campos usados aqui). */
type QueryError = { message?: string; code?: string } | null;

/** Tamanho da página ao varrer `orders` (o PostgREST limita a 1000 linhas). */
const ORDERS_PAGE_SIZE = 1000;

/** Teto de segurança da paginação (100 mil pedidos online por loja). */
const ORDERS_MAX_PAGES = 100;

/**
 * Filtro do PostgREST para pedidos com pagamento online.
 *
 * `payment_status` nasce `pendente` em todos os pedidos (migração
 * 20261110000028), então `not null` traria também os pedidos pagos na entrega.
 * O recorte correto é: forma de pagamento PIX online **ou** cobrança já emitida
 * (`asaas_payment_id`) **ou** status já processado pelo gateway.
 */
const ONLINE_PAYMENT_FILTER = [
  `payment_method.eq.${ONLINE_PAYMENT_METHOD}`,
  "asaas_payment_id.not.is.null",
  "payment_status.in.(pago,expirado,cancelado)",
].join(",");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Telefone do cliente somente com dígitos (formato salvo em `orders`). */
function phoneDigits(value: unknown): string | null {
  const digits = text(value).replace(/\D/g, "");
  return digits || null;
}

/** `created_at` em milissegundos (0 quando inválido). */
function timestamp(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Varre TODOS os pedidos da loja, paginando de 1000 em 1000.
 *
 * O Supabase/PostgREST devolve no máximo `max-rows` (1000 por padrão) por
 * requisição; sem paginação o extrato ficaria incompleto. A ordenação por
 * `created_at` + `id` mantém as páginas estáveis e a numeração curta
 * (#0001…) coerente entre carregamentos.
 */
async function fetchOrderRows(
  adminClient: ReturnType<typeof createAdminClient>,
  establishmentId: string,
  onlineOnly: boolean
): Promise<{ rows: OrderRow[]; error: QueryError }> {
  const rows: OrderRow[] = [];

  for (let page = 0; page < ORDERS_MAX_PAGES; page += 1) {
    const from = page * ORDERS_PAGE_SIZE;

    let query = adminClient
      .from("orders")
      .select("*")
      .eq("establishment_id", establishmentId);
    if (onlineOnly) query = query.or(ONLINE_PAYMENT_FILTER);

    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + ORDERS_PAGE_SIZE - 1);

    if (error) {
      return { rows: [], error: error as QueryError };
    }

    const chunk = (data ?? []) as OrderRow[];
    rows.push(...chunk);
    if (chunk.length < ORDERS_PAGE_SIZE) break;
  }

  return { rows, error: null };
}

/**
 * Pedido tem pagamento online? (usado apenas no fallback de base legada, em
 * que o filtro do PostgREST não pode ser aplicado).
 */
function hasOnlinePayment(row: OrderRow): boolean {
  if (text(row.payment_method) === ONLINE_PAYMENT_METHOD) return true;
  if (text(row.asaas_payment_id)) return true;
  return normalizePaymentStatementStatus(row.payment_status) !== "pendente";
}

/** Converte a linha de `orders` na entrada do extrato. */
function toEntry(row: OrderRow, index: number): PaymentStatementEntry {
  const status = normalizePaymentStatementStatus(row.payment_status);
  const settled = status === "pago";
  const gross = round2(money(row.total ?? row.total_amount));
  // A taxa do Split é retida no repasse: só existe quando o pagamento entrou.
  const fee = settled ? PLATFORM_FEE_REAIS : 0;
  const net = settled ? round2(Math.max(0, gross - fee)) : 0;
  const confirmedAt = text(row.payment_confirmed_at);

  return {
    id: text(row.id),
    shortNumber: `#${String(index + 1).padStart(4, "0")}`,
    created_at: text(row.created_at),
    paid_at: confirmedAt || null,
    customer_name: text(row.customer_name) || "Cliente",
    customer_phone: phoneDigits(row.customer_phone),
    payment_method: text(row.payment_method) || ONLINE_PAYMENT_METHOD,
    status,
    gross,
    fee,
    net,
    settled,
  };
}

/**
 * Resumo do mês corrente: total vendido online, taxas da plataforma e saldo
 * líquido repassado ao lojista (somente pedidos pagos).
 */
function buildSummary(
  entries: PaymentStatementEntry[],
  month: string
): PaymentStatement["summary"] {
  const range = monthRange(month);
  const start = timestamp(range.startIso);
  const end = timestamp(range.endIso);

  let paidOrders = 0;
  let pendingOrders = 0;
  let grossTotal = 0;
  let feeTotal = 0;
  let netTotal = 0;

  for (const entry of entries) {
    const created = timestamp(entry.created_at);
    if (created < start || created >= end) continue;

    if (entry.settled) {
      paidOrders += 1;
      grossTotal += entry.gross;
      feeTotal += entry.fee;
      netTotal += entry.net;
    } else if (entry.status === "pendente") {
      pendingOrders += 1;
    }
  }

  return {
    month,
    paidOrders,
    pendingOrders,
    grossTotal: round2(grossTotal),
    feeTotal: round2(feeTotal),
    netTotal: round2(netTotal),
  };
}

export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const params = new URL(request.url).searchParams;

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    params.get("establishment_id")
  );
  if ("response" in resolved) return resolved.response;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso ao financeiro deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();

  // 1ª tentativa: recorte no banco (menos tráfego). Qualquer falha do filtro
  // — colunas da migração 20261110000028 ausentes, versão do PostgREST sem
  // suporte à expressão — cai para a leitura completa + classificação em
  // memória, para o extrato nunca ficar indisponível.
  const online = await fetchOrderRows(adminClient, resolved.id, true);
  let rows: OrderRow[];

  if (!online.error) {
    rows = online.rows;
  } else {
    const fallback = await fetchOrderRows(adminClient, resolved.id, false);
    if (fallback.error) {
      return NextResponse.json(
        {
          error:
            fallback.error.message ??
            "Falha ao carregar o extrato de pagamentos. Tente novamente.",
        },
        { status: 400 }
      );
    }
    rows = fallback.rows.filter(hasOnlinePayment);
  }

  // A varredura é ascendente por `created_at` (páginas estáveis): a numeração
  // curta acompanha a ordem real de criação (#0001 = pedido mais antigo) e a
  // listagem é exibida invertida, do mais recente para o mais antigo.
  const entries = rows.map((row, index) => toEntry(row, index));
  const month = currentMonthValue();

  const statement: PaymentStatement = {
    summary: buildSummary(entries, month),
    orders: [...entries].reverse(),
    totalOrders: entries.length,
  };

  return NextResponse.json({ statement }, { status: 200 });
}
