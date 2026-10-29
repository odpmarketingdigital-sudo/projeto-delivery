/**
 * Modo catálogo: pedido/orçamento direto no WhatsApp.
 *
 * Regras do recurso "enviar pedido direto pelo WhatsApp" (migração
 * 20261110000017):
 * - A loja liga a opção em `establishments.direct_whatsapp_checkout`. Ausência
 *   da coluna/valor = modo desligado (`=== true`), mantendo intacto o fluxo de
 *   delivery tradicional (sacola -> checkout -> `POST /api/orders`).
 * - Com o modo ligado, a sacola NÃO navega para `/checkout`: monta a mensagem e
 *   abre o WhatsApp da loja. Nenhum pedido é gravado em `public.orders` — o
 *   atendimento é combinado diretamente com o lojista.
 * - Produtos sem preço (`preco` nulo/zero) são tratados como "Sob Consulta":
 *   aparecem sem valor na vitrine e a mensagem informa que o valor será
 *   verificado com o atendente.
 *
 * Importado por componentes client (`CartDrawer`, `ProductCard`,
 * `ProductModal` e `CheckoutForm`), por isso não usa APIs exclusivas do
 * navegador — a URL é apenas retornada como string.
 */

import {
  buildOrderWhatsAppUrl,
  formatWhatsAppCurrency,
  resolveStoreWhatsAppNumber,
  type WhatsAppCheckoutSettings,
} from "@/lib/whatsappOrder";

/** Campos de `establishments` usados pelo modo catálogo. */
export interface CatalogStoreSettings extends WhatsAppCheckoutSettings {
  name?: string | null;
  /** Coluna `direct_whatsapp_checkout` (migração 20261110000017). */
  direct_whatsapp_checkout?: boolean | null;
}

/** Adicional/opcional do item (mesmo formato aceito pela mensagem). */
export interface CatalogOrderAddon {
  name: string;
  price?: number | null;
}

/** Item da sacola já normalizado para a mensagem do WhatsApp. */
export interface CatalogOrderItem {
  name: string;
  quantity: number;
  /** Preço unitário (produto + adicionais). */
  unit_price?: number | null;
  /** Total da linha (unitário × quantidade). */
  line_total?: number | null;
  addons?: CatalogOrderAddon[] | null;
  notes?: string | null;
  /**
   * `true` quando o produto não possui preço fechado ("Sob Consulta"). Nesse
   * caso nenhum valor é enviado para a loja.
   */
  price_on_request?: boolean;
}

/** Conteúdo do orçamento/pedido enviado pelo WhatsApp. */
export interface CatalogOrderInput {
  items: CatalogOrderItem[];
  /** CEP informado na sacola (opcional) — frete é combinado no atendimento. */
  deliveryCep?: string | null;
  /** Observação geral digitada pelo cliente (opcional). */
  notes?: string | null;
}

/**
 * Preço "Sob Consulta": ausente, inválido ou zerado. O cardápio usa `0` quando
 * o lojista ainda não definiu o valor do item.
 */
export function isPriceOnRequest(price: number | null | undefined): boolean {
  if (typeof price !== "number" || !Number.isFinite(price)) return true;
  return price <= 0;
}

/**
 * O item da sacola é "Sob Consulta"? Considera o preço base (sem os
 * adicionais) — um produto sem preço continua sem preço mesmo com opcionais
 * pagos, e o valor final é acertado com o atendente.
 */
export function isCartItemPriceOnRequest(
  item:
    | { basePrice?: number | null; unitPrice?: number | null }
    | null
    | undefined
): boolean {
  if (!item) return false;
  const base =
    typeof item.basePrice === "number" ? item.basePrice : item.unitPrice;
  return isPriceOnRequest(base);
}

/**
 * A loja opera em modo catálogo (envio direto no WhatsApp)? Ausência da coluna
 * ou valor diferente de `true` mantém o checkout tradicional.
 */
export function isDirectWhatsAppCheckoutEnabled(
  establishment: { direct_whatsapp_checkout?: boolean | null } | null | undefined
): boolean {
  return establishment?.direct_whatsapp_checkout === true;
}

/** CEP no formato exibido (`15000-000`); mantém o valor cru se não tiver 8 dígitos. */
function formatCepForDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 8
    ? `${digits.slice(0, 5)}-${digits.slice(5)}`
    : raw.trim();
}

/** Valor monetário da linha, quando conhecido. */
function lineTotalOf(item: CatalogOrderItem): number | null {
  if (typeof item.line_total === "number" && Number.isFinite(item.line_total)) {
    return item.line_total;
  }
  if (typeof item.unit_price === "number" && Number.isFinite(item.unit_price)) {
    return (
      item.unit_price * Math.max(1, Math.floor(Number(item.quantity) || 1))
    );
  }
  return null;
}

/**
 * Monta o texto do pedido/orçamento para o WhatsApp da loja.
 *
 * Usa apenas a formatação nativa do WhatsApp (`*negrito*` / `_itálico_`). Quando
 * existe pelo menos um item "Sob Consulta" o resumo não exibe subtotal — o
 * valor é informado como "a ser verificado com o atendente".
 */
export function buildCatalogWhatsAppMessage(
  storeName: string | null | undefined,
  input: CatalogOrderInput
): string {
  const lines: string[] = [];
  const name = storeName?.trim();

  lines.push("*NOVO PEDIDO / ORÇAMENTO*");
  if (name) lines.push(`_${name} - catálogo online_`);
  lines.push("");

  lines.push("*Itens*");
  let hasPriceOnRequest = false;
  let subtotal = 0;

  for (const item of input.items) {
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const lineTotal = lineTotalOf(item);
    const onRequest =
      item.price_on_request === true ||
      (typeof item.line_total !== "number" &&
        typeof item.unit_price !== "number");

    if (onRequest) {
      hasPriceOnRequest = true;
    } else if (lineTotal != null) {
      subtotal += lineTotal;
    }

    const priceLabel = onRequest
      ? " - Sob consulta"
      : lineTotal != null
        ? ` - ${formatWhatsAppCurrency(lineTotal)}`
        : "";

    lines.push(`• ${quantity}x ${item.name.trim()}${priceLabel}`);

    for (const addon of item.addons ?? []) {
      const addonPrice =
        !onRequest &&
        typeof addon.price === "number" &&
        Number.isFinite(addon.price)
          ? ` (${formatWhatsAppCurrency(addon.price)})`
          : "";
      lines.push(`   + ${addon.name.trim()}${addonPrice}`);
    }

    if (item.notes?.trim()) {
      lines.push(`   Obs.: ${item.notes.trim()}`);
    }
  }
  lines.push("");

  lines.push("*Resumo*");
  if (hasPriceOnRequest) {
    lines.push(
      "Valor a ser verificado diretamente com o atendente via WhatsApp."
    );
  } else {
    lines.push(`Subtotal (sem frete): ${formatWhatsAppCurrency(subtotal)}`);
  }

  const cep = input.deliveryCep?.trim();
  if (cep) {
    lines.push("");
    lines.push("*Entrega*");
    lines.push(`CEP informado: ${formatCepForDisplay(cep)}`);
    lines.push("Frete e prazo a combinar com o atendente.");
  }

  if (input.notes?.trim()) {
    lines.push("");
    lines.push(`*Observações:* ${input.notes.trim()}`);
  }

  return lines.join("\n");
}

/**
 * Atalho usado pela sacola: aplica as regras da loja (modo catálogo + número
 * válido) e devolve a URL `wa.me` pronta — ou `null` quando o envio direto não
 * está disponível (a sacola então mostra o checkout tradicional).
 */
export function buildCatalogWhatsAppUrl(
  establishment: CatalogStoreSettings | null | undefined,
  input: CatalogOrderInput
): string | null {
  if (!isDirectWhatsAppCheckoutEnabled(establishment)) return null;
  const number = resolveStoreWhatsAppNumber(establishment);
  if (!number) return null;
  return buildOrderWhatsAppUrl(
    number,
    buildCatalogWhatsAppMessage(establishment?.name, input)
  );
}
