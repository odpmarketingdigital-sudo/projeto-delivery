import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { normalizeOrderStatus } from "@/lib/types";

/**
 * POST /api/orders/cancel — cancelamento do pedido pelo PRÓPRIO cliente.
 *
 * Usado pela tela de acompanhamento (`PedidoTracker`). Diferente do
 * `PUT /api/orders` (que exige sessão da loja), esta rota é pública, então a
 * autorização é feita em duas camadas:
 *
 *  1. `id` — o UUID do pedido funciona como token de acesso, o mesmo modelo já
 *     adotado pelo `GET /api/order-status`.
 *  2. `customer_phone` — quando o pedido tem telefone gravado, ele precisa
 *     pertencer ao mesmo cliente (comparação tolerante a formatação/DDI).
 *     Isso impede que alguém de posse de um id vazado cancele o pedido alheio.
 *
 * Regra de negócio: só é permitido cancelar com status ESTRITAMENTE
 * `pendente` (aguardando confirmação do restaurante). Depois disso o preparo já
 * começou e o cliente deve falar com a loja pelo WhatsApp.
 *
 * A atualização é condicional (`status = pendente` no WHERE): se a loja
 * confirmar o pedido entre a leitura e a escrita, nada é sobrescrito e a rota
 * responde 409.
 *
 * Body: { id: string, customer_phone: string }
 * Respostas: 200 { order }, 400, 403, 404, 409.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Motivo gravado em `orders.cancellation_reason` quando o cliente cancela. */
const CUSTOMER_CANCELLATION_REASON = "Cancelado pelo cliente";

/** Mensagem padrão exibida quando o pedido já saiu de `pendente`. */
const NOT_CANCELLABLE_MESSAGE =
  "Este pedido não pode mais ser cancelado pelo sistema pois já está em andamento. Caso precise, entre em contato via WhatsApp.";

function digitsOnly(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

/**
 * Compara o telefone gravado no pedido com o informado pelo cliente.
 *
 * Tolera formatação (parênteses/traços), DDI `55` e a diferença de um dígito
 * entre celulares antigos/novos — mesma lógica usada em
 * `GET /api/orders/customer`, para o cliente reconhecer o próprio pedido.
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

/** Coluna `cancellation_reason` ausente em bases legadas. */
function missingCancellationColumn(message: string): boolean {
  return (
    /cancellation_reason/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
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
    return NextResponse.json(
      { error: "Pedido inválido." },
      { status: 400 }
    );
  }

  const phoneDigits = digitsOnly(body.customer_phone);
  if (phoneDigits.length < 10) {
    return NextResponse.json(
      { error: "Informe o WhatsApp usado no pedido, com DDD." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // `select("*")` mantém compatibilidade com bases que ainda não têm as
  // colunas de cancelamento/previsão.
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
  if (currentStatus !== "pendente") {
    return NextResponse.json(
      { error: NOT_CANCELLABLE_MESSAGE, status: currentStatus },
      { status: 409 }
    );
  }

  // UPDATE condicional: só grava se o status AINDA for `pendente`.
  let { data: updated, error: updateError } = await adminClient
    .from("orders")
    .update({
      status: "cancelado",
      cancellation_reason: CUSTOMER_CANCELLATION_REASON,
    })
    .eq("id", id)
    .eq("status", "pendente")
    .select("id, status, cancellation_reason")
    .maybeSingle();

  // Base sem a migração de cancelamento: grava só o status.
  if (updateError && missingCancellationColumn(updateError.message)) {
    ({ data: updated, error: updateError } = await adminClient
      .from("orders")
      .update({ status: "cancelado" })
      .eq("id", id)
      .eq("status", "pendente")
      .select("id, status")
      .maybeSingle());
  }

  if (updateError) {
    return NextResponse.json(
      { error: updateError.message ?? "Falha ao cancelar o pedido." },
      { status: 400 }
    );
  }

  // Nenhuma linha atualizada: o status mudou entre a leitura e a escrita
  // (corrida com o painel da loja ou com outro clique do cliente).
  if (!updated) {
    return NextResponse.json(
      { error: NOT_CANCELLABLE_MESSAGE, status: null },
      { status: 409 }
    );
  }

  const persistedReason =
    typeof updated.cancellation_reason === "string"
      ? updated.cancellation_reason
      : null;

  return NextResponse.json(
    {
      order: {
        id: updated.id,
        status: "cancelado",
        cancellation_reason: persistedReason,
      },
    },
    { status: 200 }
  );
}
