import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
} from "@/lib/supabase/menuGuard";
import {
  normalizeOrderStatus,
  type CustomerHistory,
  type CustomerOrderHistory,
  type CustomerSummary,
  type PanelOrderItem,
} from "@/lib/types";

/** Linha crua de `orders` (campos tolerantes a aliases legados). */
type OrderRow = Record<string, unknown>;

/** Tamanho da página ao varrer `orders` (o PostgREST limita a 1000 linhas). */
const ORDERS_PAGE_SIZE = 1000;

/** Teto de segurança da paginação (100 mil pedidos por loja). */
const ORDERS_MAX_PAGES = 100;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function phoneDigits(value: unknown): string {
  return text(value).replace(/\D/g, "");
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Remove acentos e normaliza espaços/caixa para agrupar nomes iguais. */
function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Chave estável do cliente: telefone quando existe, senão nome normalizado. */
function customerKey(name: string, phone: string): string {
  return phone ? `phone:${phone}` : `name:${normalizeName(name)}`;
}

/** Converte o jsonb `items` em uma lista segura de itens do pedido. */
function mapItems(value: unknown): PanelOrderItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object"
    )
    .map((item) => ({
      ...(typeof item.product_id === "string"
        ? { product_id: item.product_id }
        : {}),
      name: typeof item.name === "string" ? item.name : "Item",
      quantity: money(item.quantity),
      unit_price: money(item.unit_price),
      line_total: money(item.line_total),
      ...(Array.isArray(item.addons)
        ? { addons: item.addons as NonNullable<PanelOrderItem["addons"]> }
        : {}),
      ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
    }));
}

interface CustomerAccumulator {
  key: string;
  name: string;
  phone: string | null;
  totalOrders: number;
  completedOrders: number;
  canceledOrders: number;
  totalSpent: number;
  firstOrderAt: string;
  lastOrderAt: string;
  /** Preenchido apenas quando o histórico de um cliente é solicitado. */
  orders: CustomerOrderHistory[];
}

function toSummary(acc: CustomerAccumulator): CustomerSummary {
  return {
    key: acc.key,
    name: acc.name,
    phone: acc.phone,
    totalOrders: acc.totalOrders,
    completedOrders: acc.completedOrders,
    canceledOrders: acc.canceledOrders,
    totalSpent: round2(acc.totalSpent),
    averageTicket:
      acc.totalOrders > 0 ? round2(acc.totalSpent / acc.totalOrders) : 0,
    firstOrderAt: acc.firstOrderAt,
    lastOrderAt: acc.lastOrderAt,
  };
}

/**
 * GET /api/customers/history?establishment_id=xxx[&key=phone:...]
 *
 * Agrupa os clientes a partir dos pedidos da loja (não depende da tabela
 * `customers`, que é opcional). Sem `key`, retorna apenas os resumos; com
 * `key`, retorna o resumo + histórico completo de pedidos daquele cliente.
 *
 * Segurança: exige sessão; o requisitante só acessa o próprio estabelecimento
 * (admin) ou qualquer um (super_admin).
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const params = new URL(request.url).searchParams;
  const establishmentId = params.get("establishment_id")?.trim();
  const requestedKey = params.get("key")?.trim() || null;

  if (!establishmentId) {
    return NextResponse.json(
      { error: "Parâmetro establishment_id é obrigatório." },
      { status: 400 }
    );
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    establishmentId
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso aos clientes deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const accumulators = new Map<string, CustomerAccumulator>();

  for (let page = 0; page < ORDERS_MAX_PAGES; page += 1) {
    const from = page * ORDERS_PAGE_SIZE;
    const { data, error } = await adminClient
      .from("orders")
      .select("*")
      .eq("establishment_id", establishmentId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + ORDERS_PAGE_SIZE - 1);

    if (error) {
      return NextResponse.json(
        {
          error:
            error.message ??
            "Falha ao carregar os pedidos. Verifique se a tabela orders existe.",
        },
        { status: 400 }
      );
    }

    const rows = (data ?? []) as OrderRow[];
    for (const row of rows) {
      const name = text(row.customer_name);
      const phone = phoneDigits(row.customer_phone);
      const createdAt = text(row.created_at);

      if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) continue;
      if (!name && !phone) continue;

      const key = customerKey(name, phone);
      const status = normalizeOrderStatus(row.status) ?? "pendente";
      const total = money(row.total ?? row.total_amount);

      let acc = accumulators.get(key);
      if (!acc) {
        acc = {
          key,
          name: name || "Cliente",
          phone: phone || null,
          totalOrders: 0,
          completedOrders: 0,
          canceledOrders: 0,
          totalSpent: 0,
          firstOrderAt: createdAt,
          lastOrderAt: createdAt,
          orders: [],
        };
        accumulators.set(key, acc);
      }

      // Nome mais recente (a varredura é ascendente por created_at).
      if (name) acc.name = name;
      if (!acc.phone && phone) acc.phone = phone;
      if (createdAt < acc.firstOrderAt) acc.firstOrderAt = createdAt;
      if (createdAt > acc.lastOrderAt) acc.lastOrderAt = createdAt;

      if (status === "cancelado") {
        acc.canceledOrders += 1;
      } else {
        acc.totalOrders += 1;
        acc.totalSpent += total;
        if (status === "finalizado") acc.completedOrders += 1;
      }

      if (requestedKey && key === requestedKey) {
        acc.orders.push({
          id: text(row.id),
          total: round2(total),
          status,
          created_at: createdAt,
          items: mapItems(row.items),
          coupon_code:
            typeof row.coupon_code === "string" ? row.coupon_code : null,
          coupon_discount:
            row.coupon_discount == null ? null : money(row.coupon_discount),
        });
      }
    }

    if (rows.length < ORDERS_PAGE_SIZE) break;
  }

  if (requestedKey) {
    const acc = accumulators.get(requestedKey);
    if (!acc) {
      return NextResponse.json(
        { error: "Cliente não encontrado nesta loja." },
        { status: 404 }
      );
    }
    const customer: CustomerHistory = {
      ...toSummary(acc),
      orders: acc.orders.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    };
    return NextResponse.json({ customer }, { status: 200 });
  }

  const customers = Array.from(accumulators.values())
    .map(toSummary)
    .sort(
      (a, b) =>
        new Date(b.lastOrderAt).getTime() - new Date(a.lastOrderAt).getTime()
    );

  return NextResponse.json({ customers }, { status: 200 });
}
