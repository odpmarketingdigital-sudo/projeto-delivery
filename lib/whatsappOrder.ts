/**
 * Resumo do pedido no WhatsApp.
 *
 * Regras do recurso "enviar pedido no WhatsApp no checkout":
 * - O pedido SEMPRE é gravado em `public.orders` (aparece no painel). O envio
 *   por WhatsApp é apenas um canal adicional de comunicação com a loja.
 * - A loja controla o recurso em `establishments.whatsapp_checkout_enabled`
 *   (migração 20261110000016). Ausência da coluna/valor = recurso ativo
 *   (`!== false`), mantendo o comportamento em bases legadas.
 * - Sem número de WhatsApp/telefone válido a URL não é gerada: o checkout
 *   segue funcionando normalmente.
 *
 * Importado pelo cliente (checkout/tracker) e pelo servidor (`POST /api/orders`),
 * por isso não depende de APIs exclusivas do navegador — os helpers de
 * `sessionStorage` checam `typeof window`.
 */

/** Chave do `sessionStorage` que carrega o link até a tela do pedido. */
export const WHATSAPP_ORDER_STORAGE_KEY = "ipepper:whatsapp_order_url";

/** Campos de `establishments` usados para decidir se o link deve ser gerado. */
export interface WhatsAppCheckoutSettings {
  whatsapp?: string | null;
  phone?: string | null;
  whatsapp_checkout_enabled?: boolean | null;
}

export interface WhatsAppOrderAddon {
  name: string;
  price?: number | null;
}

export interface WhatsAppOrderItem {
  name: string;
  quantity: number;
  /** Preço unitário (produto + adicionais). Opcional. */
  unit_price?: number | null;
  /** Total da linha (unitário × quantidade). Opcional. */
  line_total?: number | null;
  addons?: WhatsAppOrderAddon[] | null;
  notes?: string | null;
}

export interface WhatsAppOrderAddress {
  street?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  complement?: string | null;
  reference?: string | null;
  cep?: string | null;
}

export interface WhatsAppOrderSummaryInput {
  /** Id do pedido (`orders.id`). O código exibido usa os 8 primeiros dígitos. */
  orderId: string;
  establishmentName?: string | null;
  customerName: string;
  customerPhone?: string | null;
  items: WhatsAppOrderItem[];
  address?: WhatsAppOrderAddress | null;
  subtotal: number;
  deliveryFee: number;
  couponDiscount?: number | null;
  couponCode?: string | null;
  total: number;
  paymentMethod: string;
  changeFor?: number | null;
  notes?: string | null;
  estimatedDeliveryTime?: string | null;
}

/** Rótulos das formas de pagamento aceitas no checkout. */
const PAYMENT_LABELS: Record<string, string> = {
  pix: "Pix",
  cartao: "Cartão na entrega",
  dinheiro: "Dinheiro",
};

/** Valor monetário no padrão brasileiro (`R$ 29,90`). */
export function formatWhatsAppCurrency(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `R$ ${safe.toFixed(2).replace(".", ",")}`;
}

/**
 * Código curto do pedido exibido na mensagem (mesmo padrão de `OrdersTable`).
 * Mantém o id completo de fora para a mensagem ficar legível.
 */
export function orderShortCode(orderId: string): string {
  return `#${String(orderId ?? "").slice(0, 8)}`;
}

/**
 * Normaliza o número para o formato aceito pelo `wa.me` (DDI + DDD + número,
 * apenas dígitos). Retorna `null` quando o número é claramente inválido, para
 * que o checkout não monte um link quebrado.
 */
export function normalizeWhatsAppNumber(
  raw: string | null | undefined
): string | null {
  const digits = String(raw ?? "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");

  if (!digits) return null;
  // Número local com DDD (fixo ou celular) → prefixa o DDI do Brasil.
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  // Número já com DDI 55.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    return digits;
  }
  return null;
}

/** Telefone formatado para exibição na mensagem (`(17) 99265-0460`). */
export function formatWhatsAppPhoneForDisplay(
  raw: string | null | undefined
): string | null {
  const normalized = normalizeWhatsAppNumber(raw);
  if (!normalized) return null;

  const national = normalized.replace(/^55/, "");
  if (national.length === 11) {
    return `(${national.slice(0, 2)}) ${national.slice(2, 7)}-${national.slice(7)}`;
  }
  if (national.length === 10) {
    return `(${national.slice(0, 2)}) ${national.slice(2, 6)}-${national.slice(6)}`;
  }
  return normalized;
}

/**
 * A loja habilitou o envio do resumo no WhatsApp?
 *
 * `true` por padrão (inclui bases sem a migração) e `false` somente quando a
 * loja desativou explicitamente no painel.
 */
export function isWhatsAppCheckoutEnabled(
  establishment: WhatsAppCheckoutSettings | null | undefined
): boolean {
  if (!establishment) return false;
  return establishment.whatsapp_checkout_enabled !== false;
}

/**
 * Número oficial da loja para receber o resumo: `whatsapp` com fallback para
 * `phone`. Retorna `null` se nenhum dos dois for um número válido.
 */
export function resolveStoreWhatsAppNumber(
  establishment: WhatsAppCheckoutSettings | null | undefined
): string | null {
  if (!establishment) return null;
  return (
    normalizeWhatsAppNumber(establishment.whatsapp) ??
    normalizeWhatsAppNumber(establishment.phone)
  );
}

/** Endereço em uma linha (sem complemento/referência/CEP). */
function formatAddressLine(
  address: WhatsAppOrderAddress | null | undefined
): string {
  if (!address) return "";
  const street = address.street?.trim() ?? "";
  const number = address.number?.trim() ?? "";
  const neighborhood = address.neighborhood?.trim() ?? "";

  return [[street, number].filter(Boolean).join(", "), neighborhood]
    .filter(Boolean)
    .join(" - ");
}

/** CEP no formato exibido (`15000-000`); mantém o valor cru se não tiver 8 dígitos. */
function formatCepForDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 8
    ? `${digits.slice(0, 5)}-${digits.slice(5)}`
    : raw.trim();
}

/**
 * Monta o texto estruturado do pedido para o WhatsApp da loja.
 *
 * Usa a formatação nativa do WhatsApp (`*negrito*` / `_itálico_`) e evita
 * markdown que o aplicativo não renderiza.
 */
export function buildOrderWhatsAppMessage(
  input: WhatsAppOrderSummaryInput
): string {
  const storeName = input.establishmentName?.trim();
  const code = orderShortCode(input.orderId);
  const lines: string[] = [];

  lines.push(`*NOVO PEDIDO ${code}*`);
  if (storeName) lines.push(`_${storeName} - cardápio online_`);
  lines.push("");

  lines.push("*Cliente*");
  lines.push(`Nome: ${input.customerName.trim()}`);
  const customerPhone = formatWhatsAppPhoneForDisplay(input.customerPhone);
  if (customerPhone) lines.push(`WhatsApp: ${customerPhone}`);
  lines.push("");

  lines.push("*Itens*");
  for (const item of input.items) {
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const lineTotal =
      typeof item.line_total === "number" && Number.isFinite(item.line_total)
        ? item.line_total
        : null;
    const unitPrice =
      typeof item.unit_price === "number" && Number.isFinite(item.unit_price)
        ? item.unit_price
        : null;

    const priceLabel =
      lineTotal != null
        ? ` - ${formatWhatsAppCurrency(lineTotal)}`
        : unitPrice != null
          ? ` - ${formatWhatsAppCurrency(unitPrice)} cada`
          : "";
    lines.push(`• ${quantity}x ${item.name.trim()}${priceLabel}`);

    for (const addon of item.addons ?? []) {
      const addonPrice =
        typeof addon.price === "number" && Number.isFinite(addon.price)
          ? ` (${formatWhatsAppCurrency(addon.price)})`
          : "";
      lines.push(`   + ${addon.name.trim()}${addonPrice}`);
    }
    if (item.notes?.trim()) {
      lines.push(`   Obs.: ${item.notes.trim()}`);
    }
  }
  lines.push("");

  // O checkout atual sempre entrega no endereço informado; quando o endereço
  // não vier (ex.: retirada em fluxos futuros), o bloco é omitido.
  const addressLine = formatAddressLine(input.address);
  if (addressLine) {
    lines.push("*Endereço de entrega*");
    lines.push(addressLine);
    if (input.address?.complement?.trim()) {
      lines.push(`Complemento: ${input.address.complement.trim()}`);
    }
    if (input.address?.reference?.trim()) {
      lines.push(`Referência: ${input.address.reference.trim()}`);
    }
    if (input.address?.cep?.trim()) {
      lines.push(`CEP: ${formatCepForDisplay(input.address.cep)}`);
    }
    lines.push("");
  }

  lines.push("*Pagamento*");
  lines.push(
    PAYMENT_LABELS[input.paymentMethod] ?? input.paymentMethod ?? "Não informado"
  );
  if (
    input.paymentMethod === "dinheiro" &&
    typeof input.changeFor === "number" &&
    Number.isFinite(input.changeFor) &&
    input.changeFor > 0
  ) {
    lines.push(`Troco para: ${formatWhatsAppCurrency(input.changeFor)}`);
  }
  lines.push("");

  lines.push("*Resumo*");
  lines.push(`Subtotal: ${formatWhatsAppCurrency(input.subtotal)}`);
  const couponDiscount =
    typeof input.couponDiscount === "number" &&
    Number.isFinite(input.couponDiscount)
      ? input.couponDiscount
      : 0;
  if (couponDiscount > 0) {
    const couponLabel = input.couponCode?.trim()
      ? ` (${input.couponCode.trim()})`
      : "";
    lines.push(
      `Desconto${couponLabel}: -${formatWhatsAppCurrency(couponDiscount)}`
    );
  }
  lines.push(`Taxa de entrega: ${formatWhatsAppCurrency(input.deliveryFee)}`);
  lines.push(`*Total: ${formatWhatsAppCurrency(input.total)}*`);

  if (input.estimatedDeliveryTime?.trim()) {
    lines.push("");
    lines.push(`Previsão de entrega: ${input.estimatedDeliveryTime.trim()}`);
  }
  if (input.notes?.trim()) {
    lines.push("");
    lines.push(`*Observações:* ${input.notes.trim()}`);
  }

  return lines.join("\n");
}

/**
 * Link `wa.me` com a mensagem codificada. Retorna `null` quando o número é
 * inválido — nenhum link quebrado chega ao cliente.
 */
export function buildOrderWhatsAppUrl(
  phone: string | null | undefined,
  message: string
): string | null {
  const normalized = normalizeWhatsAppNumber(phone);
  if (!normalized) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

/**
 * Atalho usado pelo servidor: aplica as regras da loja (flag + número) e
 * devolve a URL pronta do resumo — ou `null` quando o envio está desativado.
 */
export function buildStoreOrderWhatsAppUrl(
  establishment: WhatsAppCheckoutSettings | null | undefined,
  summary: WhatsAppOrderSummaryInput
): string | null {
  if (!isWhatsAppCheckoutEnabled(establishment)) return null;
  const number = resolveStoreWhatsAppNumber(establishment);
  if (!number) return null;
  return buildOrderWhatsAppUrl(number, buildOrderWhatsAppMessage(summary));
}

/** Guarda a URL do resumo para a tela de acompanhamento (`/pedido/[id]`). */
export function savePendingOrderWhatsAppUrl(orderId: string, url: string): void {
  if (typeof window === "undefined" || !orderId || !url) return;
  try {
    window.sessionStorage.setItem(
      WHATSAPP_ORDER_STORAGE_KEY,
      JSON.stringify({ orderId, url })
    );
  } catch {
    /* armazenamento indisponível — o botão simplesmente não aparece */
  }
}

/**
 * Recupera a URL do resumo apenas quando ela pertence ao pedido informado,
 * evitando exibir o botão de um pedido anterior.
 */
export function readPendingOrderWhatsAppUrl(orderId: string): string | null {
  if (typeof window === "undefined" || !orderId) return null;
  try {
    const raw = window.sessionStorage.getItem(WHATSAPP_ORDER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { orderId?: unknown; url?: unknown };
    if (parsed?.orderId !== orderId) return null;
    return typeof parsed.url === "string" && parsed.url ? parsed.url : null;
  } catch {
    return null;
  }
}

/** Remove o link guardado (após o envio ou ao trocar de pedido). */
export function clearPendingOrderWhatsAppUrl(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(WHATSAPP_ORDER_STORAGE_KEY);
  } catch {
    /* armazenamento indisponível */
  }
}
