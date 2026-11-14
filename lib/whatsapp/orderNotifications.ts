/**
 * Notificações automáticas de pedidos pelo WhatsApp (Evolution API).
 *
 * Dois eventos do ciclo do pedido são comunicados sem intervenção humana:
 *
 * 1. **Novo pedido** (`POST /api/orders`) — a loja recebe o resumo completo do
 *    pedido (itens com observações, total, forma de pagamento e endereço ou
 *    retirada) no WhatsApp/telefone cadastrado em `establishments`;
 * 2. **Mudança de status** (`PUT /api/orders`) — o cliente recebe uma mensagem
 *    amigável no número informado no checkout (`orders.customer_phone`), com
 *    textos por etapa (`pendente`, `preparando`, `entrega`, `finalizado`,
 *    `cancelado`).
 *
 * Regras importantes:
 * - Quem envia é SEMPRE a instância da própria loja
 *   (`establishments.whatsapp_instance_name`), porque a Evolution API só entrega
 *   mensagens de um número conectado. Loja sem instância = nada é enviado.
 * - Telefones passam por `normalizeWhatsAppNumber` (DDI 55 + DDD + número), o
 *   formato do `remoteJid` do WhatsApp.
 * - A notificação NUNCA quebra o fluxo do pedido: as rotas chamam estas funções
 *   dentro de `try/catch` e só registram o resultado no log do servidor.
 * - Se a loja conectou no WhatsApp o mesmo número que recebe as notificações, a
 *   mensagem cai na conversa "Você" — comportamento do próprio WhatsApp, não um
 *   erro do sistema.
 *
 * Módulo **exclusivo do servidor** (usa `EVOLUTION_API_KEY`, nunca vai ao
 * navegador).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOrderStatus } from "@/lib/types";
import { orderDeliveryType } from "@/lib/orderStatus";
import { normalizeWhatsappInstanceName } from "@/lib/whatsappAssistant";
import {
  buildOrderWhatsAppMessage,
  normalizeWhatsAppNumber,
  orderShortCode,
  resolveStoreWhatsAppNumber,
  type WhatsAppOrderAddress,
  type WhatsAppOrderItem,
} from "@/lib/whatsappOrder";
import { sendWhatsappText } from "@/lib/whatsapp/evolution";

/**
 * Tempo máximo de UMA notificação.
 *
 * Mais curto que o padrão de `requestEvolution` (12 s) de propósito: o envio
 * acontece dentro da requisição do pedido e a Evolution fora do ar não pode
 * atrasar o checkout do cliente.
 */
export const ORDER_NOTIFICATION_TIMEOUT_MS = 6_000;

/** Colunas de `public.establishments` usadas no envio. */
export interface OrderNotificationStore {
  name?: string | null;
  /** Número divulgado pela loja (tem prioridade sobre `phone`). */
  whatsapp?: string | null;
  phone?: string | null;
  /** Instância da Evolution API vinculada à loja. */
  whatsapp_instance_name?: string | null;
}

/**
 * Subconjunto de `public.orders` usado nas mensagens.
 *
 * Números aceitam `string` porque colunas `numeric` voltam como texto em parte
 * das versões do PostgREST — tudo é convertido com `toNumber`.
 */
export interface OrderNotificationOrder {
  id: string;
  status?: string | null;
  items?: unknown;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: WhatsAppOrderAddress | null;
  subtotal?: number | string | null;
  delivery_fee?: number | string | null;
  total?: number | string | null;
  payment_method?: string | null;
  meal_voucher?: string | null;
  change_for?: number | string | null;
  notes?: string | null;
  cancellation_reason?: string | null;
  estimated_delivery_time?: string | null;
  /**
   * Modalidade do pedido (`entrega` | `retirada`, migração 20261113000001).
   * Ausente em pedidos antigos — nesse caso a modalidade é inferida pelo
   * endereço (sem endereço = retirada).
   */
  delivery_type?: string | null;
}

/** Resultado de uma tentativa de notificação. */
export interface OrderNotificationResult {
  /** `true` quando a Evolution aceitou a mensagem. */
  ok: boolean;
  /** `true` quando faltou configuração/telefone (não é erro do pedido). */
  skipped?: boolean;
  /** Motivo da falha ou da omissão (vai para o log do servidor). */
  error?: string;
}

/** Objeto simples ou `null` (JSON desconhecido vindo do banco). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Texto aparado ou `null` quando vazio/inválido. */
function readText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Número finito ou `null` (aceita `"12.90"`). */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Itens do pedido normalizados para o formato da mensagem.
 *
 * O jsonb `orders.items` é gravado por esta mesma aplicação, mas bases legadas
 * podem ter linhas incompletas: item sem nome é descartado em vez de derrubar a
 * montagem da mensagem.
 */
function toMessageItems(raw: unknown): WhatsAppOrderItem[] {
  if (!Array.isArray(raw)) return [];

  const items: WhatsAppOrderItem[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;

    const name = readText(record.name);
    if (!name) continue;

    const addons = Array.isArray(record.addons)
      ? record.addons.flatMap((value) => {
          const addon = asRecord(value);
          const addonName = readText(addon?.name);
          if (!addonName) return [];
          return [{ name: addonName, price: toNumber(addon?.price) }];
        })
      : [];

    items.push({
      name,
      quantity: Math.max(1, Math.floor(toNumber(record.quantity) ?? 1)),
      unit_price: toNumber(record.unit_price),
      line_total: toNumber(record.line_total),
      addons,
      notes: readText(record.notes),
    });
  }
  return items;
}

/**
 * Endereço do pedido ou `null` quando não há dados suficientes — nesse caso a
 * mensagem trata o pedido como **retirada** (mesma regra do painel).
 */
function toAddress(raw: unknown): WhatsAppOrderAddress | null {
  const record = asRecord(raw);
  if (!record) return null;

  const address: WhatsAppOrderAddress = {
    street: readText(record.street),
    number: readText(record.number),
    neighborhood: readText(record.neighborhood),
    complement: readText(record.complement),
    reference: readText(record.reference),
    cep: readText(record.cep),
  };

  return address.street || address.number || address.neighborhood
    ? address
    : null;
}

/** Primeiro nome do cliente (`Maria` em `Maria Aparecida Souza`). */
function customerFirstName(value: unknown): string {
  return readText(value)?.split(/\s+/)[0] ?? "";
}

/**
 * Mensagem enviada para a LOJA quando um pedido é criado.
 *
 * Reaproveita o mesmo resumo usado no link `wa.me` do checkout
 * (`buildOrderWhatsAppMessage`), garantindo que a loja veja pedido, itens com
 * observações, total, forma de pagamento e endereço/retirada no mesmo formato
 * em qualquer canal.
 */
export function buildStoreNewOrderMessage({
  store,
  order,
}: {
  store?: OrderNotificationStore | null;
  order: OrderNotificationOrder;
}): string {
  // Retirada no balcão: a mensagem da loja nunca mostra endereço (mesmo que o
  // perfil do cliente tenha um salvo de compras anteriores).
  const isPickup = orderDeliveryType(order) === "retirada";
  return buildOrderWhatsAppMessage({
    orderId: order.id,
    establishmentName: readText(store?.name),
    customerName: readText(order.customer_name) ?? "Cliente",
    customerPhone: readText(order.customer_phone),
    items: toMessageItems(order.items),
    address: isPickup ? null : toAddress(order.customer_address),
    deliveryType: order.delivery_type ?? (isPickup ? "retirada" : "entrega"),
    subtotal: toNumber(order.subtotal) ?? 0,
    deliveryFee: toNumber(order.delivery_fee) ?? 0,
    total: toNumber(order.total) ?? 0,
    paymentMethod: readText(order.payment_method) ?? "",
    mealVoucher: readText(order.meal_voucher),
    changeFor: toNumber(order.change_for),
    notes: readText(order.notes),
    estimatedDeliveryTime: readText(order.estimated_delivery_time),
  });
}

/**
 * Mensagem amigável para o CLIENTE em cada etapa do pedido.
 *
 * Retorna `null` quando o status não tem mensagem automática (ou é
 * desconhecido) — nada é enviado nesse caso.
 *
 * Os aliases aceitos na borda (`em_preparo`, `confirmado`, `saiu_para_entrega`,
 * `concluido`) são normalizados para o status canônico antes da escolha do
 * texto (ver `lib/types.ts`).
 */
export function buildCustomerStatusMessage({
  store,
  order,
  status,
}: {
  store?: OrderNotificationStore | null;
  order: OrderNotificationOrder;
  status?: string | null;
}): string | null {
  const nextStatus = normalizeOrderStatus(status ?? order.status);
  if (!nextStatus) return null;

  const code = orderShortCode(order.id);
  const storeName = readText(store?.name);
  const firstName = customerFirstName(order.customer_name);
  const greeting = firstName ? `Olá, ${firstName}!` : "Olá!";
  const storeSuffix = storeName ? ` na ${storeName}` : "";

  const estimate = readText(order.estimated_delivery_time);
  // Retirada no balcão: a previsão é de retirada, não de entrega.
  const isPickup = orderDeliveryType(order) === "retirada";
  const estimateLine = estimate
    ? `\nPrevisão de ${isPickup ? "retirada" : "entrega"}: ${estimate}`
    : "";

  switch (nextStatus) {
    case "pendente":
      return (
        `${greeting} Seu pedido ${code}${storeSuffix} foi *recebido* e está ` +
        "aguardando a confirmação da loja."
      );
    case "preparando":
      return (
        `${greeting} Seu pedido ${code}${storeSuffix} foi *confirmado* e já ` +
        `começou a ser preparado! 🍕${estimateLine}`
      );
    case "entrega":
      return isPickup
        ? `${greeting} Seu pedido ${code}${storeSuffix} está *pronto para buscar* no balcão! 🛍️${estimateLine}`
        : `${greeting} Seu pedido ${code}${storeSuffix} *saiu para entrega*! 🛵${estimateLine}`;
    case "finalizado":
      return isPickup
        ? `${greeting} Seu pedido ${code}${storeSuffix} foi *finalizado* (retirado no balcão). ` +
            "Obrigado pela preferência e bom apetite! 😋"
        : `${greeting} Seu pedido ${code}${storeSuffix} foi *finalizado*. ` +
            "Obrigado pela preferência e bom apetite! 😋";
    case "cancelado": {
      const reason = readText(order.cancellation_reason);
      const reasonLine = reason ? `\nMotivo: ${reason}` : "";
      return (
        `${greeting} Seu pedido ${code}${storeSuffix} foi *cancelado*.` +
        `${reasonLine}\nSe precisar de ajuda, é só responder esta mensagem.`
      );
    }
    default:
      return null;
  }
}

/**
 * Envio único (instância + telefone + texto). Centraliza as validações que valem
 * para qualquer notificação:
 * - sem instância configurada a loja não tem WhatsApp conectado → omite;
 * - telefone inválido (sem DDD/DDI) → omite;
 * - falha da Evolution → registra o motivo no log e devolve `ok: false`.
 */
async function sendOrderNotification({
  store,
  phone,
  text,
  event,
}: {
  store?: OrderNotificationStore | null;
  phone: string | null;
  text: string;
  event: string;
}): Promise<OrderNotificationResult> {
  const instanceName = normalizeWhatsappInstanceName(
    store?.whatsapp_instance_name
  );
  if (!instanceName) {
    return {
      ok: false,
      skipped: true,
      error:
        "A loja não tem instância da Evolution API configurada (whatsapp_instance_name).",
    };
  }

  if (!phone) {
    return { ok: false, skipped: true, error: "Telefone de destino inválido." };
  }

  const result = await sendWhatsappText({
    instanceName,
    phone,
    text,
    timeoutMs: ORDER_NOTIFICATION_TIMEOUT_MS,
  });

  if (!result.ok) {
    console.warn(
      `[whatsapp:pedido] ${event} não enviado: ${result.error ?? "erro desconhecido"}`
    );
    return { ok: false, error: result.error ?? "Falha ao enviar a mensagem." };
  }

  console.info(`[whatsapp:pedido] ${event} enviado (instância ${instanceName}).`);
  return { ok: true };
}

/**
 * Notifica a LOJA sobre um pedido recém-criado.
 *
 * Destino: `establishments.whatsapp` com fallback para `establishments.phone`
 * (mesma regra do resumo do checkout, ver `resolveStoreWhatsAppNumber`).
 */
export async function notifyStoreNewOrder({
  store,
  order,
}: {
  store?: OrderNotificationStore | null;
  order: OrderNotificationOrder;
}): Promise<OrderNotificationResult> {
  // Resolvido antes do texto: sem destino a mensagem nem é montada.
  const phone = resolveStoreWhatsAppNumber(store ?? null);
  if (!phone) {
    return {
      ok: false,
      skipped: true,
      error: "A loja não tem WhatsApp/telefone válido cadastrado.",
    };
  }

  return sendOrderNotification({
    store,
    phone,
    text: buildStoreNewOrderMessage({ store, order }),
    event: `novo pedido ${orderShortCode(order.id)}`,
  });
}

/**
 * Notifica o CLIENTE sobre o novo status do pedido.
 *
 * Só envia quando o status tem texto próprio (ver `buildCustomerStatusMessage`)
 * e o pedido tem telefone válido.
 */
export async function notifyCustomerOrderStatus({
  store,
  order,
  status,
}: {
  store?: OrderNotificationStore | null;
  order: OrderNotificationOrder;
  status?: string | null;
}): Promise<OrderNotificationResult> {
  const nextStatus = normalizeOrderStatus(status ?? order.status);
  if (!nextStatus) {
    return {
      ok: false,
      skipped: true,
      error: "Status desconhecido — nenhuma mensagem foi enviada.",
    };
  }

  const text = buildCustomerStatusMessage({ store, order, status: nextStatus });
  if (!text) {
    return {
      ok: false,
      skipped: true,
      error: `O status "${nextStatus}" não tem mensagem automática.`,
    };
  }

  const phone = normalizeWhatsAppNumber(order.customer_phone);
  if (!phone) {
    return {
      ok: false,
      skipped: true,
      error: "O pedido não tem telefone do cliente.",
    };
  }

  return sendOrderNotification({
    store,
    phone,
    text,
    event: `status ${nextStatus} do pedido ${orderShortCode(order.id)}`,
  });
}

/**
 * Notificação de mudança de etapa com proteção contra repetição.
 *
 * Reenviar o MESMO status (ex.: o operador só ajustou a previsão de entrega no
 * painel) não pode virar mensagem duplicada para o cliente.
 */
export async function notifyOrderStatusChange({
  store,
  order,
  previousStatus,
}: {
  store?: OrderNotificationStore | null;
  order: OrderNotificationOrder;
  previousStatus?: string | null;
}): Promise<OrderNotificationResult> {
  const previous = normalizeOrderStatus(previousStatus);
  const next = normalizeOrderStatus(order.status);

  if (next && previous === next) {
    return { ok: false, skipped: true, error: "O status não mudou." };
  }

  return notifyCustomerOrderStatus({ store, order, status: next });
}

/**
 * Carrega as colunas da loja usadas nas notificações.
 *
 * `select("*")` mantém a tolerância a bases sem as migrações mais recentes
 * (mesmo padrão de `POST /api/orders`); os campos são lidos de forma defensiva.
 */
export async function fetchOrderNotificationStore(
  admin: SupabaseClient,
  establishmentId: string | null | undefined
): Promise<OrderNotificationStore | null> {
  const id = typeof establishmentId === "string" ? establishmentId.trim() : "";
  if (!id) return null;

  const { data, error } = await admin
    .from("establishments")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error(
      "[whatsapp:pedido] falha ao carregar a loja para notificação:",
      error.message
    );
    return null;
  }

  const row = asRecord(data);
  if (!row) return null;

  return {
    name: readText(row.name),
    whatsapp: readText(row.whatsapp),
    phone: readText(row.phone),
    whatsapp_instance_name: readText(row.whatsapp_instance_name),
  };
}
