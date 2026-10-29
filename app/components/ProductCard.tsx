"use client";

import type { Product } from "@/lib/types";
import { isPriceOnRequest } from "@/lib/catalogOrder";

interface ProductCardProps {
  product: Product;
  /** Quantidade do produto já presente no carrinho. */
  quantity: number;
  /** Remove uma unidade do produto no carrinho. */
  onRemove: (productId: string) => void;
  /**
   * Abre o modal de detalhes do produto (opcionais, observações e quantidade).
   * Toda adição passa pelo modal — o card não escolhe quantidade.
   */
  onSelect?: (product: Product) => void;
}

export function ProductCard({
  product,
  quantity,
  onRemove,
  onSelect,
}: ProductCardProps) {
  // Produto sem preço definido (0/nulo) = "Sob Consulta" no catálogo.
  const priceOnRequest = isPriceOnRequest(product.preco);
  const formattedPrice = priceOnRequest
    ? ""
    : `R$ ${product.preco.toFixed(2).replace(".", ",")}`;

  // Estoque controlado e zerado => item esgotado na vitrine.
  const soldOut =
    product.track_stock === true && (product.stock_quantity ?? 0) <= 0;

  // O card (e o botão "Adicionar") apenas abre o modal de detalhes. É lá que
  // o cliente escolhe opcionais, observações e a quantidade.
  const handleSelect = () => {
    if (soldOut) return;
    onSelect?.(product);
  };

  return (
    <article
      onClick={handleSelect}
      className={`group flex h-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition duration-200 dark:border-gray-800 dark:bg-gray-900 ${onSelect ? "cursor-pointer" : ""} ${
        soldOut ? "opacity-80" : "hover:-translate-y-0.5 hover:shadow-md"
      }`}
    >
      <div className="relative h-32 w-full shrink-0 overflow-hidden bg-gray-100 sm:h-36 dark:bg-gray-800">
        {/* <img> simples: aceita caminhos locais e URLs remotas (Supabase
            Storage) sem passar pela otimização de imagens do Next. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={product.image_url || "/window.svg"}
          alt={product.nome}
          className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
        />
        <span className="absolute left-2 top-2 inline-flex max-w-[calc(100%-1rem)] truncate rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white backdrop-blur-sm">
          {product.categoria}
        </span>
        {soldOut && (
          <span className="absolute right-2 top-2 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm">
            Esgotado
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3 sm:p-4">
        <h3 className="truncate text-sm font-semibold leading-tight text-gray-900 sm:text-[15px] dark:text-white">
          {product.nome}
        </h3>
        <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {product.descricao}
        </p>

        <div className="mt-auto flex flex-col gap-2 pt-3">
          <div className="flex items-end justify-between gap-2">
            {priceOnRequest ? (
              <span className="inline-flex items-center rounded-full border border-amber-400/50 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-300">
                Sob Consulta
              </span>
            ) : (
              <span className="text-[15px] font-extrabold tabular-nums text-gray-900 sm:text-base dark:text-white">
                {formattedPrice}
              </span>
            )}

            {/* Quantidade já presente no carrinho */}
            {quantity > 0 && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800"
              >
                <span
                  title={`${quantity} unidade(s) no carrinho`}
                  className="rounded-full px-1 text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-300"
                >
                  {quantity} no carrinho
                </span>
                <button
                  type="button"
                  aria-label={`Remover uma unidade de ${product.nome}`}
                  onClick={() => onRemove(product.id)}
                  className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-[11px] font-bold leading-none text-gray-600 shadow-sm transition hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-gray-200 dark:hover:text-red-400"
                >
                  −
                </button>
              </div>
            )}
          </div>

          {/* Botão único "Adicionar": abre o modal de detalhes.
              A quantidade é escolhida apenas dentro do modal. */}
          <div onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={handleSelect}
              disabled={soldOut}
              aria-label={
                soldOut
                  ? `${product.nome} está esgotado`
                  : `Adicionar ${product.nome} ao carrinho`
              }
              className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 sm:text-sm ${
                soldOut
                  ? "cursor-not-allowed bg-gray-200 text-gray-500 focus:ring-gray-300 dark:bg-gray-800 dark:text-gray-500 dark:focus:ring-gray-700 dark:focus:ring-offset-gray-900"
                  : "bg-gray-900 text-white hover:bg-gray-700 focus:ring-gray-900 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:focus:ring-yellow-400 dark:focus:ring-offset-gray-900"
              }`}
            >
              {soldOut ? (
                "Esgotado"
              ) : (
                <>
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 4.5v15m7.5-7.5h-15"
                    />
                  </svg>
                  Adicionar
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
