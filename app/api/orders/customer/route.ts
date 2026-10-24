import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { normalizeOrderStatus } from "@/lib/types";
import type { PanelOrder } from "@/lib/types";

/**
 * GET /api/orders/customer?phone=xxx&establishment_id=xxx
 *
 * Consulta PÚBLICA o histórico de pedidos de um cliente numa loja específica.
 * `establishment_id` aceita o UUID **ou** o slug público (resolvido aqui).
 * `phone` é comparado de forma flexível: o valor salvo em `customer_phone`
 * (string formatada ou só dígitos) é normalizado para dígitos e casado com o
 * telefone consultado.
 *
 * Responde 400 se faltar `phone`/`establishment_id`; 404 se nenhum pedido
 * foi encontrado; senão 200 com `{ orders: PanelOrder[] }` (mais recentes).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const phone = params.get("phone")?.trim() || "";
  const establishmentParam = params.get("establishment_id")?.trim() || "";

  if (!phone) {
    return NextResponse.json(
      { error: "Informe o telefone do cliente." },
      { status: 400 }
    );
  }
  if (!establishmentParam) {
    return NextResponse.json(
      { error: "establishment_id obrigatório." },
      { status: 400 }
    );
  }

  const targetDigits = phone.replace(/\D/g, "");
  if (targetDigits.length < 10) {
    return NextResponse.json(
      { error: "Telefone inválido: informe ao menos 10 dígitos com DDD." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // 1) Resolve o estabelecimento: aceita UUID ou slug público.
  let establishmentId = establishmentParam;
  if (!UUID_RE.test(establishmentParam)) {
    const { data: est, error: estError } = await adminClient
      .from("establishments")
      .select("id")
      .eq("slug", establishmentParam)
      .maybeSingle();

    if (estError) {
      return NextResponse.json(
        { error: estError.message ?? "Falha ao resolver o estabelecimento." },
        { status: 500 }
      );
    }
    if (!est) {
      // Slug desconhecido — responde 404 vazio (nenhum pedido nesta loja).
      return NextResponse.json({ orders: [] }, { status: 404 });
    }
    establishmentId = String(est.id);
  }

  // 2) Busca os pedidos da loja já filtrando por `establishment_id` no banco
  //    (muito mais eficiente e correto do que trazer tudo e filtrar em memória).
  const { data, error } = await adminClient
    .from("orders")
    .select("*")
    .eq("establishment_id", establishmentId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: error.message ?? "Falha ao carregar os pedidos." },
      { status: error.message?.includes("column") ? 400 : 500 }
    );
  }

  const rows = Array.isArray(data) ? data : [];

  // 3) Filtra por telefone do cliente (tolerante a formatação).
  const orders = rows
    .filter((row) =>
      phoneMatches(
        (row as { customer_phone?: unknown }).customer_phone,
        targetDigits
      )
    )
    .map((row) => normalizeOrder(row))
    .filter((o): o is PanelOrder => o !== null);

  if (orders.length === 0) {
    return NextResponse.json({ orders: [] }, { status: 404 });
  }

  return NextResponse.json({ orders }, { status: 200 });
}

/** Remove tudo que não for dígito. */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Converte `customer_phone` (string simples, lista separada por vírgula ou
 * array) numa lista de strings brutas.
 *
 * IMPORTANTE: não parte por `-` — a formatação `(XX) XXXXX-XXXX` usa hífen.
 */
function toPhoneList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v ?? ""));
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Tenta interpretar como JSON array ("[\"...\"]").
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v ?? ""));
    } catch {
      /* não é JSON — segue como string simples */
    }
  }
  // String simples: mantém intacta (o `-` é parte da máscara do telefone).
  // Aceita múltiplos números separados por vírgula/ponto-e-vírgula.
  return trimmed
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Compara o telefone salvo (formatado ou dígitos) com o telefone consultado
 * (somente dígitos). Tolera DDI `55` e diferença de um dígito (celular × fixo).
 */
function phoneMatches(raw: unknown, targetDigits: string): boolean {
  return toPhoneList(raw).some((candidate) => {
    const cleaned = digitsOnly(candidate);
    // Ignora candidatos curtos demais (evita falsos positivos por prefixo).
    if (cleaned.length < 8) return false;
    const strip55 = (d: string) =>
      d.length > 11 && d.startsWith("55") ? d.slice(2) : d;
    const a = strip55(cleaned);
    const b = strip55(targetDigits);
    return a === b || a.startsWith(b) || b.startsWith(a);
  });
}

/** Normaliza uma linha crua de `public.orders` para `PanelOrder`. */
function normalizeOrder(raw: unknown): PanelOrder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  if (!id) return null;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const items = Array.isArray(r.items) ? r.items : [];
  const status = normalizeOrderStatus(r.status);
  if (!status) return null;
  const addr = r.customer_address;
  return {
    id,
    establishment_id: String((r.establishment_id ?? "")),
    customer_name: typeof r.customer_name === "string" ? r.customer_name : "",
    customer_phone: typeof r.customer_phone === "string" ? r.customer_phone : null,
    customer_address:
      addr && typeof addr === "object" ? (addr as PanelOrder["customer_address"]) : null,
    items: items.map((it) => normalizeItem(it)),
    subtotal: num(r.subtotal),
    delivery_fee: num(r.delivery_fee),
    total: num(r.total),
    payment_method: typeof r.payment_method === "string" ? r.payment_method : "—",
    change_for: typeof r.change_for === "number" ? r.change_for : null,
    notes: typeof r.notes === "string" ? r.notes : null,
    delivery_type:
      typeof r.delivery_type === "string" ? r.delivery_type : null,
    status,
    cancellation_reason:
      typeof r.cancellation_reason === "string" ? r.cancellation_reason : null,
    estimated_delivery_time:
      typeof r.estimated_delivery_time === "string"
        ? r.estimated_delivery_time
        : null,
    estimated_delivery_at:
      typeof r.estimated_delivery_at === "string"
        ? r.estimated_delivery_at
        : null,
    created_at: typeof r.created_at === "string" ? r.created_at : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

function normalizeItem(raw: unknown): PanelOrder["items"][0] {
  if (typeof raw !== "object" || raw === null) return { name: "Item", quantity: 1, unit_price: 0, line_total: 0 };
  const it = raw as Record<string, unknown>;
  return {
    product_id: typeof it.product_id === "string" ? it.product_id : undefined,
    name: typeof it.name === "string" ? it.name : "Item",
    quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
    unit_price: Number(it.unit_price) || 0,
    line_total: Number(it.line_total) || 0,
    addons: Array.isArray(it.addons)
      ? (it.addons as Array<Record<string, unknown>>)
          .filter((a) => typeof a?.name === "string")
          .map((a) => ({
            id: typeof a.id === "string" ? a.id : "",
            name: String(a.name),
            price: Number(a.price) || 0,
          }))
      : [],
    notes: typeof it.notes === "string" ? it.notes : undefined,
  };
}
