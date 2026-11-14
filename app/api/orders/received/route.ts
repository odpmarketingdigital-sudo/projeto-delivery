import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { normalizeOrderStatus } from "@/lib/types";

/**
 * POST /api/orders/received — confirmação de recebimento pelo PRÓPRIO cliente.
 *
 * Usado pelo botão **"Recebi o pedido"** da tela de acompanhamento
 * (`/pedido/[id]`). Diferente do `PUT /api/orders` (que exige sessão da loja),
 * esta rota é pública, então a autorização segue o mesmo modelo do
 * `POST /api/orders/cancel`:
 *
 *  1. `id` — o UUID do pedido funciona como token de acesso (mesmo padrão do
 *     `GET /api/order-status`);
 *  2. `customer_phone` — quando o pedido tem telefone gravado, ele precisa
 *     pertencer ao mesmo cliente (comparação tolerante a formatação/DDI).
 *     Isso impede que alguém de posse de um id vazado encerre o pedido alheio.
 *
 * Regra de negócio: só é permitido confirmar quando o pedido está em
 * `entrega` — ou seja, já saiu para entrega ou está "Pronto para buscar" no
 * caso de retirada no balcão. Antes disso o pedido ainda está em preparo.
 *
 * A atualização é condicional (`status = entrega` no WHERE): se a loja mudar o
 * status entre a leitura e a escrita, nada é sobrescrito e a rota responde 409.
 *
 * Body: { id: string, customer_phone: string }
 * Respostas: 200 { order }, 400, 403, 404, 409.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mensagem padrão quando o pedido ainda não chegou à etapa final. */
const NOT_RECEIVABLE_MESSAGE =
  "Este pedido ainda não saiu para entrega nem está pronto para retirada.";

function digitsOnly(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

/**
 * Compara o telefone gravado no pedido com o informado pelo cliente.
 * Tolera formatação, DDI `55` e o nono dígito — mesma lógica de
 * `POST /api/orders/cancel` e `GET /api/orders/customer`.
 */
function phoneMatches(rawStored: unknown, targetDigits: string): boolean {
  const stored = digitsOnly(rawStored);
  if (stored.length < 8 || targetDigits.length < 8) return false;
  const strip55 = (digits: string): string =>
    digits.length > 11 && digits.startsWith("55") ? digits.slice(2) : digits;
  const a = strip55(stored);
  const b = strip55(targetDigits);
  return a === b || a.slice(-8) === b.slice(-8);
}

export async function POST(request: Request) {
  let body: { id?: unknown; customer_phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json(
      { error: "Informe o id do pedido." },
      { status: 400 }
    );
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 });
  }

  const phoneDigits = digitsOnly(body.customer_phone);
  if (phoneDigits.length < 10) {
    return NextResponse.json(
      { error: "Informe o WhatsApp usado no pedido, com DDD." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // `select("*")` mantém compatibilidade com bases sem as migrações recentes.
  const { data: existing, error: findError } = await adminClient
    .from("orders")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o pedido." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json(
      { error: "Pedido não encontrado." },
      { status: 404 }
    );
  }

  const row = existing as { status?: unknown; customer_phone?: unknown };

  // Camada 2 de autorização: o telefone precisa ser do dono do pedido.
  // Pedidos legados sem telefone gravado seguem protegidos apenas pelo UUID.
  if (
    digitsOnly(row.customer_phone) &&
    !phoneMatches(row.customer_phone, phoneDigits)
  ) {
    return NextResponse.json(
      { error: "Não foi possível confirmar que este pedido pertence a você." },
      { status: 403 }
    );
  }

  const currentStatus = normalizeOrderStatus(row.status);
  if (currentStatus !== "entrega") {
    return NextResponse.json(
      { error: NOT_RECEIVABLE_MESSAGE, status: currentStatus },
      { status: 409 }
    );
  }

  // UPDATE condicional: só grava se o status AINDA for `entrega`.
  const { data: updated, error: updateError } = await adminClient
    .from("orders")
    .update({ status: "finalizado" })
    .eq("id", id)
    .eq("status", "entrega")
    .select("id, status")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json(
      { error: updateError.message ?? "Falha ao confirmar o recebimento." },
      { status: 400 }
    );
  }

  // Nenhuma linha atualizada: o status mudou entre a leitura e a escrita
  // (corrida com o painel da loja ou outro clique do cliente).
  if (!updated) {
    return NextResponse.json(
      { error: NOT_RECEIVABLE_MESSAGE, status: null },
      { status: 409 }
    );
  }

  return NextResponse.json(
    { order: { id: updated.id, status: "finalizado" } },
    { status: 200 }
  );
}
