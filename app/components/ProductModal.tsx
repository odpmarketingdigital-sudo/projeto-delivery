"use client";
import { useEffect, useMemo, useState } from "react";
import { useCart } from "@/context/CartContext";
import type { Product, ProductOption } from "@/lib/types";

interface ProductModalProps {
  product: Product | null;
  onClose: () => void;
  /**
   * Quantidade pré-selecionada (opcional). A vitrine não envia mais esse valor
   * — a quantidade é escolhida apenas dentro do modal —, mas o parâmetro segue
   * disponível para usos que precisem abrir o modal já com um valor.
   */
  initialQuantity?: number;
}
const formatBRL = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`;

/** Limite máximo de itens por adição. */
const MAX_QUANTITY = 99;

/** Normaliza a quantidade pré-selecionada para um inteiro em [1, limite]. */
function normalizeInitialQuantity(
  value: number | undefined,
  max: number
): number {
  const limit = Math.max(1, Math.floor(max));
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(limit, Math.max(1, Math.floor(value)));
}

export function ProductModal({
  product,
  onClose,
  initialQuantity,
}: ProductModalProps) {
  const { addCustomItem } = useCart();
  const groups = useMemo(() => product?.option_groups ?? [], [product]);

  // Estoque controlado define o teto do seletor de quantidade. Sem controle de
  // estoque, vale o limite padrão do carrinho.
  const stockQuantity =
    product?.track_stock === true
      ? Math.max(0, Math.floor(Number(product.stock_quantity) || 0))
      : MAX_QUANTITY;
  const maxQuantity = Math.min(MAX_QUANTITY, stockQuantity);
  const soldOut = product?.track_stock === true && stockQuantity <= 0;

  // Estados com inicialização baseada no produto atual
  const [prevProductId, setPrevProductId] = useState(product?.id);
  const [selection, setSelection] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    const initialGroups = product?.option_groups ?? [];
    for (const g of initialGroups) {
      initial[g.id] = g.required && g.options.length > 0 ? [g.options[0].id] : [];
    }
    return initial;
  });
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState(() =>
    normalizeInitialQuantity(initialQuantity, maxQuantity)
  );
  const [triedSubmit, setTriedSubmit] = useState(false);

  // Redefine o estado durante a renderização se o produto mudar (padrão recomendado pelo React)
  if (product?.id !== prevProductId) {
    setPrevProductId(product?.id);
    const newInitial: Record<string, string[]> = {};
    for (const g of groups) {
      newInitial[g.id] = g.required && g.options.length > 0 ? [g.options[0].id] : [];
    }
    setSelection(newInitial);
    setNotes("");
    setQuantity(normalizeInitialQuantity(initialQuantity, maxQuantity));
    setTriedSubmit(false);
  }

  useEffect(() => {
    if (!product) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [product, onClose]);

  const selectedOptions: ProductOption[] = useMemo(() => {
    const all = new Map<string, ProductOption>();
    for (const g of groups) for (const o of g.options) all.set(o.id, o);
    const list: ProductOption[] = [];
    for (const ids of Object.values(selection)) for (const id of ids) {
      const opt = all.get(id); if (opt) list.push(opt);
    }
    return list;
  }, [selection, groups]);

  const basePrice = product?.preco ?? 0;
  const unitPrice = basePrice + selectedOptions.reduce((a, o) => a + o.price, 0);
  const totalPrice = unitPrice * quantity;
  const missingRequired = groups.filter((g) => g.required && (selection[g.id]?.length ?? 0) === 0);

  const handleSubmit = () => {
    if (!product) return;
    if (soldOut) return;
    if (missingRequired.length > 0) {
      setTriedSubmit(true);
      document.getElementById(`group-${missingRequired[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    addCustomItem({
      productId: product.id,
      productName: product.nome,
      basePrice: product.preco,
      imageUrl: product.image_url,
      establishmentId: product.establishmentId,
      categoryName: product.category ?? product.categoria,
      selectedOptions,
      notes: notes.trim(),
      quantidade: quantity,
    });
    onClose();
  };

  if (!product) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={`Customizar ${product.nome}`} className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <button aria-label="Fechar" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div className="relative flex max-h-[100dvh] w-full flex-col overflow-hidden bg-white dark:bg-gray-900 sm:max-h-[90vh] sm:max-w-lg sm:rounded-3xl sm:shadow-2xl">
        <div className="relative h-52 w-full shrink-0 sm:h-60">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={product.image_url || "/window.svg"}
            alt={product.nome}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
          <button type="button" onClick={onClose} aria-label="Voltar para o cardápio" className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-lg font-bold text-white backdrop-blur transition hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/60">
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
            </svg>
          </button>
          <div className="absolute bottom-3 left-4 right-4">
            <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold uppercase text-amber-700">{product.categoria}</span>
            <h2 className="mt-1 text-xl font-bold text-white">{product.nome}</h2>
            <p className="line-clamp-2 text-sm text-white/85">{product.descricao}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between text-sm"><span className="font-semibold uppercase tracking-wider text-xs text-gray-400">Preço base</span><span className="font-bold tabular-nums dark:text-white">{formatBRL(product.preco)}</span></div>
          {product.track_stock && (
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Estoque</span>
              <span className={`font-bold tabular-nums ${stockQuantity === 0 ? "text-red-500" : "dark:text-white"}`}>
                {stockQuantity === 0
                  ? "Esgotado"
                  : `${stockQuantity} ${stockQuantity === 1 ? "unidade" : "unidades"}`}
              </span>
            </div>
          )}
          {groups.map((g) => (
            <fieldset key={g.id} id={`group-${g.id}`} className="mt-4 rounded-2xl border border-gray-200/80 bg-gray-50/60 p-3.5 dark:border-gray-700/60 dark:bg-gray-800/40">
              <legend className="px-1 text-sm font-bold dark:text-white">{g.title} {g.required ? <span className="ml-1 rounded-full bg-gray-900 px-2 py-0.5 text-[10px] uppercase text-white dark:bg-yellow-400 dark:text-gray-950">Obrigatório</span> : <span className="ml-1 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] uppercase text-gray-500">Opcional</span>}</legend>
              {(triedSubmit && (selection[g.id]?.length ?? 0) === 0 && g.required) && <p className="mb-2 text-xs font-semibold text-red-500">Escolha uma opção para continuar.</p>}
              <div className="flex flex-col gap-1.5">
                {g.options.map((o) => {
                  const checked = selection[g.id]?.includes(o.id) ?? false;
                  return (
                    <label key={o.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${checked ? "border-gray-900 bg-white dark:border-yellow-400 dark:bg-gray-900" : "border-transparent"}`}>
                      <input type={g.required ? "radio" : "checkbox"} name={g.id} checked={checked} onChange={() => setSelection((p) => {
                        if (g.required) return { ...p, [g.id]: [o.id] };
                        const cur = p[g.id] ?? [];
                        if (cur.includes(o.id)) return { ...p, [g.id]: cur.filter((x) => x !== o.id) };
                        if (g.maxSelect && cur.length >= g.maxSelect) return p;
                        return { ...p, [g.id]: [...cur, o.id] };
                      })} className="h-4 w-4 accent-gray-900 dark:accent-yellow-400" />
                      <span className="flex-1 font-medium dark:text-gray-100">{o.name}</span>
                      <span className="text-xs font-bold tabular-nums text-gray-500">{o.price > 0 ? `+ ${formatBRL(o.price)}` : "Incluso"}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <div className="mt-4">
            <label htmlFor="notes" className="mb-1.5 block text-sm font-bold dark:text-white">Observações <span className="font-normal text-gray-400">(opcional)</span></label>
            <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={300} placeholder="Ex: Sem cebola, molho à parte..." className="w-full resize-none rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm focus:border-gray-900 focus:outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          </div>
          {/* Seletor de quantidade: [-] [n] [+] */}
          <div className="mt-4 rounded-2xl bg-gray-100 p-3 dark:bg-gray-800">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-bold text-gray-700 dark:text-gray-200">Quantidade</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={`Diminuir a quantidade de ${product.nome}`}
                  disabled={quantity <= 1}
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-lg font-bold leading-none text-gray-700 shadow-sm transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
                >
                  −
                </button>
                <span
                  aria-live="polite"
                  aria-label={`Quantidade selecionada: ${quantity}`}
                  className="min-w-8 text-center text-base font-bold tabular-nums text-gray-900 dark:text-white"
                >
                  {quantity}
                </span>
                <button
                  type="button"
                  aria-label={`Aumentar a quantidade de ${product.nome}`}
                  disabled={quantity >= maxQuantity}
                  onClick={() =>
                    setQuantity((q) => Math.min(Math.max(1, maxQuantity), q + 1))
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-900 text-lg font-bold leading-none text-white shadow-sm transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
                >
                  +
                </button>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-gray-200 pt-2.5 text-sm dark:border-gray-700">
              <span className="text-gray-500 dark:text-gray-400">
                {quantity} {quantity === 1 ? "item" : "itens"} × {formatBRL(unitPrice)}
              </span>
              <span className="font-bold tabular-nums text-gray-900 dark:text-white">{formatBRL(totalPrice)}</span>
            </div>
          </div>
          <div className="h-24" />
        </div>
        <div className="absolute inset-x-0 bottom-0 border-t bg-white/95 px-4 pb-6 pt-3 backdrop-blur dark:bg-gray-900/95">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={soldOut}
            className="w-full rounded-xl bg-gray-900 px-4 py-3.5 text-sm font-bold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:cursor-not-allowed disabled:bg-gray-400 disabled:text-gray-100 disabled:hover:bg-gray-400 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:disabled:bg-gray-700 dark:disabled:text-gray-400 dark:disabled:hover:bg-gray-700"
          >
            {soldOut
              ? "Esgotado"
              : `Adicionar ao Carrinho - ${formatBRL(totalPrice)}`}
          </button>
        </div>
      </div>
    </div>
  );
}