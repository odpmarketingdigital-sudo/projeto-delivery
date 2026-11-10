/**
 * /api/asaas/pix-payment — cobrança PIX Online do checkout da vitrine (Split).
 *
 * `POST { order_id, refresh? }`
 *  - carrega o pedido + a loja (subconta conectada em `/painel/configuracoes`);
 *  - cria/reaproveita o cliente no Asaas **usando a credencial da subconta**;
 *  - cria a cobrança `POST /v3/payments` (billingType PIX) com o Split fixo de
 *    R$ 0,50 para a carteira da plataforma (`ASAAS_PLATFORM_WALLET_ID`). O saldo
 *    restante fica na subconta do lojista, porque a cobrança é emitida por ela;
 *  - devolve o Pix Copia e Cola (`payload`) e a imagem do QR Code
 *    (`encoded_image`, PNG em base64) para o modal do checkout.
 *
 * `GET ?order_id=...`
 *  - status do pagamento para o polling do modal. Quando o webhook ainda não
 *    chegou (ou não está configurado), concilia direto com o Asaas e grava
 *    `payment_status = 'pago'` — mesma rotina idempotente do webhook.
 *
 * Sem sessão: o id do pedido (uuid) funciona como token, do mesmo jeito que
 * `/api/order-status`. A rota nunca expõe a API key da subconta.
 */

import { NextResponse } from "next/server";
import {
  AsaasError,
  createAsaasPixPayment,
  deleteAsaasPayment,
  findOrCreateAsaasCustomer,
  formatAsaasDate,
  getAsaasPayment,
  getPixQrCode,
} from "@/lib/asaas";
import { PLATFORM_FEE_CENTS, PLATFORM_FEE_LABEL } from "@/lib/asaasSubaccount";
import { isPaidPaymentStatus, isValidCpfCnpj, onlyDigits } from "@/lib/billing";
import { ORDER_PAYMENT_STATUS, markOrderPaid } from "@/lib/orderPayments";
import { createAdminClient } from "@/lib/supabase/server";

/** Taxa fixa da plataforma por pedido pago online (reais). */
const PLATFORM_FEE = PLATFORM_FEE_CENTS / 100;

const MISSING_MIGRATION =
  "O pagamento online ainda não está disponível no banco. Execute a migração " +
  "20261110000028_add_asaas_pix_online_payments.sql no Supabase.";

/** Linha crua de `orders` (colunas novas podem faltar em bases legadas). */
interface OrderRow {
  id: string;
  establishment_id: string | null;
  status: string | null;
  payment_method: string | null;
  payment_status?: string | null;
  asaas_payment_id?: string | null;
  total: number | string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_document?: string | null;
}

/** Linha crua de `establishments` com os campos do Split. */
interface StoreRow {
  id: string;
  name?: string | null;
  slug?: string | null;
  accept_pix_online?: boolean | null;
  asaas_account_id?: string | null;
  asaas_wallet_id?: string | null;
  asaas_api_key?: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Status do Asaas em que a cobrança não pode mais ser exibida/paga. */
const DEAD_ASAAS_STATUSES = new Set([
  "DELETED",
  "REFUNDED",
  "REFUND_REQUESTED",
]);

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `expirationDate` do Asaas vem como `YYYY-MM-DD HH:mm:ss` no fuso de Brasília
 * (sem timezone). Normaliza para ISO/UTC para o cronômetro do modal.
 */
function toIsoDateTime(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const hasTimezone =
    /Z$/i.test(normalized) || /[+-]\d{2}:?\d{2}$/.test(normalized);
  const parsed = new Date(hasTimezone ? normalized : `${normalized}-03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function describeAsaasFailure(error: unknown): {
  message: string;
  status: number;
} {
  if (error instanceof AsaasError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    return { message: error.message, status };
  }
  return {
    message: "Não foi possível gerar a cobrança PIX. Tente novamente.",
    status: 502,
  };
}

async function loadOrder(orderId: string): Promise<
  | { ok: true; order: OrderRow }
  | { ok: false; response: NextResponse }
> {
  const id = orderId.trim();
  if (!UUID_PATTERN.test(id)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Informe um order_id válido." },
        { status: 400 }
      ),
    };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("orders")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[asaas/pix-payment] falha ao ler o pedido", error);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Não foi possível localizar o pedido." },
        { status: 500 }
      ),
    };
  }
  if (!data) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Pedido não encontrado." },
        { status: 404 }
      ),
    };
  }

  return { ok: true, order: data as OrderRow };
}

async function loadStore(
  establishmentId: string | null
): Promise<StoreRow | null> {
  if (!establishmentId) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("establishments")
    .select("*")
    .eq("id", establishmentId)
    .maybeSingle();
  return (data as StoreRow | null) ?? null;
}

/** Payload devolvido ao checkout (QR + status). */
function pixPayload(input: {
  orderId: string;
  value: number;
  paymentId: string | null;
  paymentStatus: string | null;
  payload: string;
  encodedImage: string;
  expirationDate: string | null;
}) {
  const expiresAt = toIsoDateTime(input.expirationDate);
  return {
    order_id: input.orderId,
    payment_id: input.paymentId,
    value: input.value,
    status: input.paymentStatus,
    payload: input.payload,
    encoded_image: input.encodedImage,
    expiration_date: input.expirationDate,
    expires_at: expiresAt,
    platform_fee: PLATFORM_FEE,
    platform_fee_label: PLATFORM_FEE_LABEL,
    paid: false,
  };
}

export async function POST(request: Request) {
  let body: { order_id?: string; refresh?: boolean };
  try {
    body = (await request.json()) as { order_id?: string; refresh?: boolean };
  } catch {
    return NextResponse.json(
      { error: "Requisição inválida (JSON esperado)." },
      { status: 400 }
    );
  }

  const orderId = typeof body.order_id === "string" ? body.order_id.trim() : "";
  const refresh = body.refresh === true;

  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded.response;
  const order = loaded.order;

  if (order.status === "cancelado") {
    return NextResponse.json(
      { error: "Este pedido foi cancelado — não é possível gerar o PIX." },
      { status: 409 }
    );
  }
  if (order.payment_method !== "pix_online") {
    return NextResponse.json(
      { error: "Este pedido não foi feito com PIX Online." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Pagamento já confirmado: nada a gerar (idempotência para duplo-envio).
  if (order.payment_status === ORDER_PAYMENT_STATUS.paid) {
    return NextResponse.json(
      {
        order_id: order.id,
        payment_id: order.asaas_payment_id ?? null,
        paid: true,
        payment_status: ORDER_PAYMENT_STATUS.paid,
      },
      { status: 200 }
    );
  }

  const store = await loadStore(order.establishment_id);
  if (!store) {
    return NextResponse.json(
      { error: "Estabelecimento do pedido não encontrado." },
      { status: 404 }
    );
  }

  if (store.accept_pix_online !== true || !store.asaas_account_id) {
    return NextResponse.json(
      {
        error:
          "O PIX Online não está disponível nesta loja no momento. " +
          "Escolha outra forma de pagamento.",
      },
      { status: 409 }
    );
  }

  // A cobrança é emitida pela SUBCONTA: sem a credencial dela não há como
  // manter o saldo com o lojista e enviar apenas a taxa no Split.
  const apiKey = store.asaas_api_key?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "O recebimento online desta loja precisa ser reconectado. Abra " +
          "Painel → Configurações → Pagamento Online e salve novamente.",
      },
      { status: 409 }
    );
  }

  const platformWalletId = process.env.ASAAS_PLATFORM_WALLET_ID?.trim();
  if (!platformWalletId) {
    console.error(
      "[asaas/pix-payment] ASAAS_PLATFORM_WALLET_ID não configurado — Split indisponível."
    );
    return NextResponse.json(
      {
        error:
          "Pagamento online indisponível: carteira da plataforma não configurada no servidor.",
      },
      { status: 500 }
    );
  }

  const total = toNumber(order.total);
  if (total <= PLATFORM_FEE) {
    return NextResponse.json(
      {
        error: `O valor do pedido precisa ser maior que a taxa online de ${PLATFORM_FEE_LABEL}.`,
      },
      { status: 400 }
    );
  }

  const document = onlyDigits(order.customer_document ?? "");
  if (!isValidCpfCnpj(document)) {
    return NextResponse.json(
      {
        error:
          "CPF/CNPJ do pagador é obrigatório para gerar o PIX Online. " +
          "Refaça o pedido informando o documento.",
      },
      { status: 400 }
    );
  }

  // 1) Cobrança já existente e ainda pagável: reaproveita (evita duplicidade
  //    em duplo-clique, recarregamento do modal ou retomada do pedido).
  if (!refresh && order.asaas_payment_id) {
    try {
      const existing = await getAsaasPayment(order.asaas_payment_id, { apiKey });

      if (isPaidPaymentStatus(existing.status)) {
        await markOrderPaid(admin, { orderId: order.id, paymentId: existing.id });
        return NextResponse.json(
          {
            order_id: order.id,
            payment_id: existing.id,
            paid: true,
            payment_status: ORDER_PAYMENT_STATUS.paid,
          },
          { status: 200 }
        );
      }

      if (!DEAD_ASAAS_STATUSES.has(existing.status)) {
        const qr = await getPixQrCode(existing.id, { apiKey });
        return NextResponse.json(
          pixPayload({
            orderId: order.id,
            value: total,
            paymentId: existing.id,
            paymentStatus: existing.status,
            payload: qr.payload,
            encodedImage: qr.encodedImage,
            expirationDate: qr.expirationDate ?? null,
          }),
          { status: 200 }
        );
      }
    } catch (error) {
      // Cobrança removida/indisponível no gateway: segue para uma nova.
      console.warn(
        `[asaas/pix-payment] cobrança ${order.asaas_payment_id} indisponível — gerando outra.`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // QR Code expirado (`refresh`): remove a cobrança antiga antes de criar a
  // nova, para não deixar dois QRs pagáveis para o mesmo pedido.
  if (refresh && order.asaas_payment_id) {
    try {
      await deleteAsaasPayment(order.asaas_payment_id, { apiKey });
    } catch (error) {
      console.warn(
        `[asaas/pix-payment] não foi possível remover a cobrança ${order.asaas_payment_id}`,
        error instanceof Error ? error.message : error
      );
    }
  }

  try {
    // 2) Cliente do Asaas DENTRO da subconta (cada conta tem a própria base).
    const customer = await findOrCreateAsaasCustomer(
      {
        name: order.customer_name?.trim() || "Cliente",
        cpfCnpj: document,
        phone: order.customer_phone ?? "",
        externalReference: store.id,
      },
      { apiKey }
    );

    // 3) Cobrança PIX com Split: taxa fixa da plataforma.
    const payment = await createAsaasPixPayment(
      {
        customerId: customer.id,
        value: total,
        dueDate: formatAsaasDate(),
        description: `Pedido ${order.id.slice(0, 8)} · ${store.name?.trim() || "Loja"}`,
        externalReference: order.id,
        split:
          store.asaas_wallet_id && store.asaas_wallet_id === platformWalletId
            ? // Split para a própria conta emissora é recusado pelo Asaas.
              []
            : [{ walletId: platformWalletId, fixedValue: PLATFORM_FEE }],
      },
      { apiKey }
    );

    // 4) QR Code dinâmico (imagem + Copia e Cola).
    const qr = await getPixQrCode(payment.id, { apiKey });
    const expirationDate = qr.expirationDate ?? null;

    // 5) Snapshot no pedido — usado pelo acompanhamento e pela conciliação.
    const { error: saveError } = await admin
      .from("orders")
      .update({
        asaas_payment_id: payment.id,
        payment_status: ORDER_PAYMENT_STATUS.pending,
        customer_document: document,
        pix_payload: qr.payload,
        pix_expiration: toIsoDateTime(expirationDate),
      })
      .eq("id", order.id);

    if (saveError) {
      const missingColumns =
        /payment_status|pix_payload|pix_expiration|customer_document|asaas_payment_id/i.test(
          saveError.message ?? ""
        ) &&
        /does not exist|could not find|schema cache/i.test(
          saveError.message ?? ""
        );
      if (missingColumns) {
        console.error(`[asaas/pix-payment] ${MISSING_MIGRATION}`, saveError);
      } else {
        console.error(
          `[asaas/pix-payment] cobrança ${payment.id} criada, mas o pedido ${order.id} não foi atualizado`,
          saveError
        );
      }
      // A cobrança existe e o webhook a encontra por `externalReference`:
      // devolvemos o QR mesmo assim para não travar o cliente.
    }

    return NextResponse.json(
      pixPayload({
        orderId: order.id,
        value: total,
        paymentId: payment.id,
        paymentStatus: payment.status ?? null,
        payload: qr.payload,
        encodedImage: qr.encodedImage,
        expirationDate,
      }),
      { status: 201 }
    );
  } catch (error) {
    const failure = describeAsaasFailure(error);
    console.error(
      `[asaas/pix-payment] falha ao gerar a cobrança do pedido ${order.id}`,
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: failure.message },
      { status: failure.status }
    );
  }
}

export async function GET(request: Request) {
  const orderId =
    new URL(request.url).searchParams.get("order_id")?.trim() ?? "";

  const loaded = await loadOrder(orderId);
  if (!loaded.ok) return loaded.response;
  const order = loaded.order;

  if (order.payment_status === ORDER_PAYMENT_STATUS.paid) {
    return NextResponse.json(
      {
        order_id: order.id,
        payment_id: order.asaas_payment_id ?? null,
        paid: true,
        payment_status: ORDER_PAYMENT_STATUS.paid,
      },
      { status: 200 }
    );
  }

  const store = await loadStore(order.establishment_id);
  const apiKey = store?.asaas_api_key?.trim() || "";

  // Conciliação de fallback: consulta o gateway quando o webhook ainda não
  // chegou (ou não está configurado). Falhas aqui não derrubam o polling.
  if (order.asaas_payment_id && apiKey) {
    try {
      const payment = await getAsaasPayment(order.asaas_payment_id, { apiKey });
      if (isPaidPaymentStatus(payment.status)) {
        const admin = createAdminClient();
        await markOrderPaid(admin, {
          orderId: order.id,
          paymentId: payment.id,
        });
        return NextResponse.json(
          {
            order_id: order.id,
            payment_id: payment.id,
            paid: true,
            payment_status: ORDER_PAYMENT_STATUS.paid,
          },
          { status: 200 }
        );
      }
      return NextResponse.json(
        {
          order_id: order.id,
          payment_id: payment.id,
          paid: false,
          payment_status: order.payment_status ?? ORDER_PAYMENT_STATUS.pending,
          gateway_status: payment.status,
          value: toNumber(order.total),
        },
        { status: 200 }
      );
    } catch (error) {
      console.warn(
        `[asaas/pix-payment] conciliação do pedido ${order.id} indisponível`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return NextResponse.json(
    {
      order_id: order.id,
      payment_id: order.asaas_payment_id ?? null,
      paid: order.payment_status === ORDER_PAYMENT_STATUS.paid,
      payment_status: order.payment_status ?? ORDER_PAYMENT_STATUS.pending,
      value: toNumber(order.total),
    },
    { status: 200 }
  );
}
