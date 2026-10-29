"use client";

import { useCart } from "@/context/CartContext";
import { isCartItemPriceOnRequest } from "@/lib/catalogOrder";

interface CartSummaryProps {
  /** Abre a sacola (drawer) onde o frete é calculado antes do checkout. */
  onOpen: () => void;
  /** Loja atual: o resumo mostra apenas itens desta loja. */
  establishmentId?: string | null;
  /** true = loja fechada no momento (aviso + checkout bloqueado na página). */
  storeClosed?: boolean;
  /** Ex.: "hoje às 18:00" — exibido no aviso de loja fechada. */
  nextOpeningLabel?: string | null;
}

const formatBRL = (value: number) =>
  `R$ ${value.toFixed(2).replace(".", ",")}`;

/**
 * Barra fixa de resumo da sacola.
 *
 * O CTA apenas abre o `CartDrawer`; o checkout fica dentro dele, depois que o
 * frete foi calculado/validado. Assim o cliente nunca avança sem ver a taxa.
 */
export function CartSummary({
  onOpen,
  establishmentId,
  storeClosed = false,
  nextOpeningLabel,
}: CartSummaryProps) {
  const { items } = useCart();

  // Em vitrines por slug mostramos somente os itens da loja atual. O checkout
  // aplica o mesmo filtro, então subtotal e contagem permanecem consistentes.
  const visibleItems = establishmentId
    ? items.filter((item) => item.establishmentId === establishmentId)
    : items;

  const itemCount = visibleItems.reduce(
    (acc, item) => acc + item.quantidade,
    0
  );
  const subtotal = visibleItems.reduce((acc, item) => {
    if (typeof item.itemTotalPrice === "number") {
      return acc + item.itemTotalPrice;
    }
    const unit =
      item.unitPrice ??
      (item.basePrice ?? 0) +
        (item.selectedOptions ?? []).reduce((sum, option) => sum + option.price, 0);
    return acc + unit * item.quantidade;
  }, 0);

  const hasItems = visibleItems.length > 0 && itemCount > 0;
  // Item "Sob Consulta" (preço nulo/zero): o subtotal não é confiável, então a
  // barra troca o valor pela mensagem de verificação com o atendente.
  const hasPriceOnRequest = visibleItems.some((item) =>
    isCartItemPriceOnRequest(item)
  );

  if (!hasItems) return null;

  return (
    <footer className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-200/70 bg-white/95 px-4 pb-6 pt-3 backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/95 sm:px-6">
      {storeClosed && (
        <p
          role="status"
          className="mx-auto mb-2 max-w-2xl rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
        >
          O estabelecimento encontra-se fechado no momento e não está recebendo
          pedidos.
          {nextOpeningLabel ? ` Abrimos ${nextOpeningLabel}.` : ""}
        </p>
      )}
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            {hasPriceOnRequest ? "Valores" : "Subtotal"}
          </span>
          {hasPriceOnRequest ? (
            <span className="text-sm font-bold leading-tight text-amber-600 dark:text-amber-300">
              Sob Consulta
            </span>
          ) : (
            <span className="text-lg font-bold tabular-nums text-gray-900 dark:text-white">
              {formatBRL(subtotal)}
            </span>
          )}
          <span className="text-[10px] font-medium text-gray-400">
            {hasPriceOnRequest
              ? "Valor verificado no WhatsApp"
              : "Frete calculado na sacola"}
          </span>
        </div>

        <button
          type="button"
          onClick={onOpen}
          aria-label={`Abrir sacola com ${itemCount} ${
            itemCount === 1 ? "item" : "itens"
          }`}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 sm:flex-none sm:px-6 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:focus:ring-yellow-400 dark:focus:ring-offset-gray-900"
        >
          Ver sacola
          <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-white/25 px-2 py-0.5 text-xs font-bold tabular-nums dark:bg-black/20">
            {itemCount}
          </span>
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
            />
          </svg>
        </button>
      </div>
    </footer>
  );
}

