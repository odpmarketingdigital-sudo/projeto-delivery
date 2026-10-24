import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  MONTH_SHORT,
  currentMonthValue,
  currentYearValue,
  dayRange,
  daysInMonth,
  formatDateBR,
  getZonedDateParts,
  isValidDateValue,
  isValidMonthValue,
  isValidYearValue,
  monthRange,
  todayDateValue,
  yearRange,
  type DateRange,
} from "@/lib/dateRange";
import {
  normalizeOrderStatus,
  type DashboardData,
  type DashboardDayHighlight,
  type DashboardPeriod,
  type DashboardSeriesPoint,
} from "@/lib/types";

/** Linha crua de `orders` (campos tolerantes a aliases legados). */
type OrderRow = {
  status?: unknown;
  total?: unknown;
  total_amount?: unknown;
  created_at?: unknown;
};

/** Tamanho da página ao varrer `orders` (o PostgREST limita a 1000 linhas). */
const ORDERS_PAGE_SIZE = 1000;

/** Teto de segurança para a paginação (1 milhão de pedidos por período). */
const ORDERS_MAX_PAGES = 1000;

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Busca TODOS os pedidos do período, paginando em blocos de 1000.
 *
 * O Supabase/PostgREST devolve no máximo `max-rows` (1000 por padrão) por
 * requisição; sem a paginação, períodos longos (mês/ano) teriam o faturamento
 * subestimado. A ordenação por `created_at` + `id` mantém as páginas estáveis
 * mesmo quando vários pedidos compartilham o mesmo timestamp.
 */
async function fetchOrdersForRange(
  adminClient: ReturnType<typeof createAdminClient>,
  establishmentId: string,
  range: DateRange
): Promise<{ rows: OrderRow[]; error: string | null }> {
  const rows: OrderRow[] = [];

  for (let page = 0; page < ORDERS_MAX_PAGES; page += 1) {
    const from = page * ORDERS_PAGE_SIZE;
    const { data, error } = await adminClient
      .from("orders")
      .select("*")
      .eq("establishment_id", establishmentId)
      .gte("created_at", range.startIso)
      .lt("created_at", range.endIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + ORDERS_PAGE_SIZE - 1);

    if (error) {
      return {
        rows,
        error:
          error.message ??
          "Falha ao carregar os pedidos do período selecionado.",
      };
    }

    const chunk = (data ?? []) as OrderRow[];
    rows.push(...chunk);
    if (chunk.length < ORDERS_PAGE_SIZE) break;
  }

  return { rows, error: null };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultPeriodValue(period: DashboardPeriod): string {
  if (period === "month") return currentMonthValue();
  if (period === "year") return currentYearValue();
  return todayDateValue();
}

function isValidPeriodValue(period: DashboardPeriod, value: string): boolean {
  if (period === "month") return isValidMonthValue(value);
  if (period === "year") return isValidYearValue(value);
  return isValidDateValue(value);
}

function periodRange(period: DashboardPeriod, value: string): DateRange {
  if (period === "month") return monthRange(value);
  if (period === "year") return yearRange(value);
  return dayRange(value);
}

/**
 * Cria os buckets da série temporal:
 * - day   → 24 horas (00h..23h)
 * - month → todos os dias do mês (01/MM..)
 * - year  → 12 meses (Jan..Dez)
 */
function createSeries(
  period: DashboardPeriod,
  value: string
): DashboardSeriesPoint[] {
  if (period === "day") {
    return Array.from({ length: 24 }, (_, hour) => ({
      key: String(hour),
      label: `${pad2(hour)}h`,
      revenue: 0,
      orders: 0,
    }));
  }

  if (period === "month") {
    const [year, month] = value.split("-").map(Number);
    const totalDays = daysInMonth(year, month);
    return Array.from({ length: totalDays }, (_, index) => {
      const day = index + 1;
      return {
        key: `${value}-${pad2(day)}`,
        label: `${pad2(day)}/${pad2(month)}`,
        revenue: 0,
        orders: 0,
      };
    });
  }

  return MONTH_SHORT.map((label, index) => ({
    key: `${value}-${pad2(index + 1)}`,
    label,
    revenue: 0,
    orders: 0,
  }));
}

/** Chave do bucket correspondente ao timestamp convertido para o fuso da loja. */
function seriesKey(period: DashboardPeriod, parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
}): string {
  if (period === "day") return String(parts.hour);
  if (period === "month") {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }
  return `${parts.year}-${pad2(parts.month)}`;
}

/** Agrega as linhas de pedidos no payload do dashboard. */
function buildDashboard(
  rows: OrderRow[],
  period: DashboardPeriod,
  value: string,
  range: DateRange
): DashboardData {
  const series = createSeries(period, value);
  const bucketByKey = new Map(series.map((point) => [point.key, point]));
  const dayMap = new Map<string, DashboardDayHighlight>();

  let revenue = 0;
  let orders = 0;
  let canceledOrders = 0;

  for (const row of rows) {
    const status = normalizeOrderStatus(row.status);
    if (!status) continue;

    if (status === "cancelado") {
      canceledOrders += 1;
      continue;
    }

    const createdAt = typeof row.created_at === "string" ? row.created_at : "";
    if (!createdAt) continue;

    const total = toNumber(row.total ?? row.total_amount);
    const parts = getZonedDateParts(createdAt);

    const bucket = bucketByKey.get(seriesKey(period, parts));
    if (bucket) {
      bucket.revenue += total;
      bucket.orders += 1;
    }

    revenue += total;
    orders += 1;

    const dateKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    const day = dayMap.get(dateKey) ?? {
      date: dateKey,
      label: formatDateBR(dateKey),
      revenue: 0,
      orders: 0,
    };
    day.revenue += total;
    day.orders += 1;
    dayMap.set(dateKey, day);
  }

  for (const point of series) {
    point.revenue = round2(point.revenue);
  }

  const days = [...dayMap.values()];
  for (const day of days) {
    day.revenue = round2(day.revenue);
  }

  const topDay = days.reduce<DashboardDayHighlight | null>(
    (best, day) => (!best || day.revenue > best.revenue ? day : best),
    null
  );
  const bottomDay = days.reduce<DashboardDayHighlight | null>(
    (worst, day) => (!worst || day.revenue < worst.revenue ? day : worst),
    null
  );

  return {
    period,
    value,
    startIso: range.startIso,
    endIso: range.endIso,
    revenue: round2(revenue),
    orders,
    averageTicket: orders > 0 ? round2(revenue / orders) : 0,
    canceledOrders,
    topDay,
    bottomDay,
    series,
  };
}

/**
 * GET /api/dashboard?period=day|month|year&value=...&establishment_id=...
 *
 * - period=day   → value YYYY-MM-DD (bucket por hora)
 * - period=month → value YYYY-MM   (bucket por dia)
 * - period=year  → value YYYY      (bucket por mês)
 *
 * Pedidos cancelados não entram em faturamento/pedidos/ticket médio; o total
 * de cancelados é devolvido separadamente.
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const params = new URL(request.url).searchParams;
  const periodParam = params.get("period")?.trim() || "day";
  if (periodParam !== "day" && periodParam !== "month" && periodParam !== "year") {
    return NextResponse.json(
      { error: "Período inválido. Use: day, month ou year." },
      { status: 400 }
    );
  }
  const period = periodParam as DashboardPeriod;

  const value = params.get("value")?.trim() || defaultPeriodValue(period);
  if (!isValidPeriodValue(period, value)) {
    const format =
      period === "month" ? "YYYY-MM" : period === "year" ? "YYYY" : "YYYY-MM-DD";
    return NextResponse.json(
      { error: `Valor inválido para o período. Use o formato ${format}.` },
      { status: 400 }
    );
  }

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
      { error: "Você não tem acesso aos dados deste estabelecimento." },
      { status: 403 }
    );
  }

  const range = periodRange(period, value);
  const adminClient = createAdminClient();

  const { rows, error } = await fetchOrdersForRange(
    adminClient,
    resolved.id,
    range
  );

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  const dashboard = buildDashboard(rows, period, value, range);

  return NextResponse.json({ dashboard }, { status: 200 });
}

