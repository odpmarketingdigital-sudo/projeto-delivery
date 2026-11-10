/**
 * POST /api/asaas/webhook — confirmação automática das cobranças PIX do
 * checkout (Split de Pagamentos).
 *
 * O endpoint trata os eventos de cobrança do Asaas:
 *  - `PAYMENT_RECEIVED`   → dinheiro liquidado;
 *  - `PAYMENT_CONFIRMED`  → pagamento confirmado (PIX cai antes da liquidação).
 * Em ambos o pedido passa para `payment_status = 'pago'` e recebe
 * `payment_confirmed_at`. Os demais eventos são apenas confirmados (200).
 *
 * Vínculo com o pedido:
 *  1. `payment.externalReference` → `orders.id` (gravado na criação da
 *     cobrança em `/api/asaas/pix-payment`);
 *  2. `payment.id` → `orders.asaas_payment_id` (fallback).
 *
 * Tempo real: o UPDATE em `orders` é publicado no Realtime do Supabase
 * (migração 20261110000021), então o Kanban do painel e o acompanhamento do
 * cliente atualizam sozinhos — não há push manual.
 *
 * Segurança: mesma regra de `/api/webhooks/asaas` — o Asaas envia o token
 * configurado no header `asaas-access-token`, comparado em tempo constante
 * com `ASAAS_WEBHOOK_TOKEN`. Sem o token configurado o endpoint falha fechado
 * (500). As subcontas recebem esse webhook automaticamente na conexão do
 * recebimento online (`ensureAsaasWebhook`).
 *
 * Idempotência: o Asaas entrega eventos "at least once". `markOrderPaid` só
 * grava enquanto o pedido não está pago, então reenvios não geram UPDATE.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ORDER_PAYMENT_STATUS, markOrderPaid } from "@/lib/orderPayments";
import { createAdminClient } from "@/lib/supabase/server";

/** Eventos que confirmam o pagamento. */
const PAID_EVENTS = new Set([
  "PAYMENT_RECEIVED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED_IN_CASH",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cobrança embutida no payload (apenas os campos usados). */
interface AsaasWebhookPayment {
  id?: string;
  status?: string;
  externalReference?: string | null;
  invoiceUrl?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
}

interface AsaasWebhookBody {
  id?: string;
  event?: string;
  payment?: AsaasWebhookPayment | null;
}

interface OrderLookup {
  id: string;
  payment_status?: string | null;
}

function ack() {
  return NextResponse.json({ received: true }, { status: 200 });
}

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Comparação em tempo constante (evita vazar o token por timing). */
function isValidToken(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received.trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Data de confirmação informada pelo Asaas (ISO) ou `null`. */
function confirmedAt(payment: AsaasWebhookPayment): string | null {
  const raw =
    payment.paymentDate || payment.confirmedDate || payment.clientPaymentDate;
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : `${raw}T12:00:00-03:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Localiza o pedido da cobrança (externalReference → asaas_payment_id). */
async function findOrder(
  admin: ReturnType<typeof createAdminClient>,
  payment: AsaasWebhookPayment
): Promise<OrderLookup | null> {
  const externalReference = payment.externalReference?.trim() ?? "";
  if (externalReference && UUID_PATTERN.test(externalReference)) {
    const { data, error } = await admin
      .from("orders")
      .select("*")
      .eq("id", externalReference)
      .maybeSingle();
    if (error) {
      console.error("[webhook/asaas] falha ao ler o pedido (externalReference)", error);
    } else if (data) {
      return data as OrderLookup;
    }
  }

  const paymentId = payment.id?.trim() ?? "";
  if (!paymentId) return null;

  const { data, error } = await admin
    .from("orders")
    .select("*")
    .eq("asaas_payment_id", paymentId)
    .maybeSingle();

  if (error) {
    // Base sem a migração 20261110000028: não há como localizar pela cobrança.
    console.error("[webhook/asaas] falha ao ler o pedido (asaas_payment_id)", error);
    return null;
  }
  return (data as OrderLookup | null) ?? null;
}

export async function POST(request: Request) {
  const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN?.trim();

  if (!expectedToken) {
    console.error(
      "[webhook/asaas] ASAAS_WEBHOOK_TOKEN não configurado — eventos recusados."
    );
    return fail("Webhook não configurado.", 500);
  }

  if (!isValidToken(request.headers.get("asaas-access-token"), expectedToken)) {
    console.warn("[webhook/asaas] token ausente ou inválido — evento recusado.");
    return fail("Token do webhook inválido.", 401);
  }

  let body: AsaasWebhookBody;
  try {
    body = (await request.json()) as AsaasWebhookBody;
  } catch {
    return fail("Payload inválido (JSON esperado).", 400);
  }

  const event =
    typeof body.event === "string" ? body.event.trim().toUpperCase() : "";
  const payment = body.payment ?? null;

  // Sem cobrança no payload (ex.: evento de assinatura) ou evento que não
  // confirma pagamento: confirma o recebimento sem tocar em pedidos.
  if (!payment) return ack();
  if (!PAID_EVENTS.has(event)) {
    console.info(`[webhook/asaas] evento ignorado: ${event || "desconhecido"}`);
    return ack();
  }

  const admin = createAdminClient();
  const order = await findOrder(admin, payment);

  if (!order) {
    // Cobrança sem pedido vinculado (ex.: pagamento da assinatura da loja
    // tratado em /api/webhooks/asaas) — nada a fazer.
    console.info(
      `[webhook/asaas] ${event}: cobrança ${payment.id ?? "?"} sem pedido vinculado.`
    );
    return ack();
  }

  // Reenvio do Asaas: o pedido já está pago — não escreve de novo.
  if (order.payment_status === ORDER_PAYMENT_STATUS.paid) {
    return ack();
  }

  const changed = await markOrderPaid(admin, {
    orderId: order.id,
    paymentId: payment.id ?? null,
    confirmedAt: confirmedAt(payment),
  });

  console.info(
    `[webhook/asaas] ${event}: pedido ${order.id} ` +
      (changed ? "marcado como PAGO" : "já pago (reenvio ignorado)") +
      (payment.id ? ` · cobrança ${payment.id}` : "")
  );

  return ack();
}
