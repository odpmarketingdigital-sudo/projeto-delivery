import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/order-status?id=xxx — acompanhamento PÚBLICO do pedido.
 *
 * Sem sessão: o id (uuid) funciona como token de acesso. Retorna apenas os
 * campos necessários à tela do cliente (status, itens, endereço, pagamento,
 * total) + WhatsApp da loja para o botão "Falar no WhatsApp".
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "Informe o id do pedido." }, { status: 400 });
  }

  const adminClient = createAdminClient();
  const { data: order, error } = await adminClient
    .from("orders")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message ?? "Falha ao localizar o pedido." },
      { status: 400 }
    );
  }
  if (!order) {
    return NextResponse.json({ error: "Pedido não encontrado." }, { status: 404 });
  }

  const establishmentId =
    typeof order.establishment_id === "string" ? order.establishment_id : null;
  let whatsapp: string | null = null;
  let establishmentName = "Restaurante";
  // Slug público da loja (coluna nullable em bases legadas) — usado pelo
  // tracker para montar o link "Voltar ao cardápio" (rota /[slug]).
  let establishmentSlug: string | null = null;
  if (establishmentId) {
    const { data: est } = await adminClient
      .from("establishments")
      .select("name, whatsapp, phone, slug")
      .eq("id", establishmentId)
      .maybeSingle();
    if (est && typeof est === "object") {
      const row = est as { name?: unknown; whatsapp?: unknown; phone?: unknown; slug?: unknown };
      if (typeof row.name === "string" && row.name.trim()) {
        establishmentName = row.name.trim();
      }
      if (typeof row.slug === "string" && row.slug.trim()) {
        establishmentSlug = row.slug.trim();
      }
      const raw =
        (typeof row.whatsapp === "string" && row.whatsapp) ||
        (typeof row.phone === "string" && row.phone) ||
        "";
      const digits = raw.replace(/\D/g, "");
      whatsapp = digits ? (digits.startsWith("55") ? digits : `55${digits}`) : null;
    }
  }

  return NextResponse.json(
    {
      order: {
        id: order.id,
        status: order.status,
        items: Array.isArray(order.items) ? order.items : [],
        customer_address:
          order.customer_address && typeof order.customer_address === "object"
            ? order.customer_address
            : null,
        subtotal: Number(order.subtotal ?? order.total ?? 0) || 0,
        delivery_fee: Number(order.delivery_fee ?? 0) || 0,
        total: Number(order.total ?? 0) || 0,
        payment_method: order.payment_method ?? "—",
        notes: typeof order.notes === "string" ? order.notes : null,
        cancellation_reason:
          typeof order.cancellation_reason === "string"
            ? order.cancellation_reason
            : null,
        estimated_delivery_time:
          typeof order.estimated_delivery_time === "string"
            ? order.estimated_delivery_time
            : null,
        estimated_delivery_at:
          typeof order.estimated_delivery_at === "string"
            ? order.estimated_delivery_at
            : null,
        created_at: order.created_at,
      },
      establishment: { name: establishmentName, whatsapp, slug: establishmentSlug },
    },
    { status: 200 }
  );
}
