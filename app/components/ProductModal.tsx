"use client";
import { useEffect, useMemo, useState } from "react";
import { useCart } from "@/context/CartContext";
import type {
  Product,
  ProductOption,
  ProductOptionGroup,
} from "@/lib/types";
import { isPriceOnRequest } from "@/lib/catalogOrder";
import {
  HALF_HALF_FLAVOR_COUNT,
  buildHalfHalfFlavors,
  halfHalfFlavorsLabel,
  resolveHalfHalfBasePrice,
  toHalfHalfFlavor,
} from "@/lib/halfHalf";

interface ProductModalProps {
  product: Product | null;
  onClose: () => void;
  /**
   * Produtos candidatos ao 2º sabor quando `product.allow_half_half` é true:
   * itens ativos da mesma categoria, com `allow_half_half` habilitado, exceto o
   * próprio produto (que já ocupa o 1º sabor).
   */
  halfHalfOptions?: Product[];
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

/** Modo de preparo de um produto habilitado para meio a meio. */
type HalfHalfMode = "whole" | "half";

/** Normaliza a quantidade pré-selecionada para um inteiro em [1, limite]. */
function normalizeInitialQuantity(
  value: number | undefined,
  max: number
): number {
  const limit = Math.max(1, Math.floor(max));
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(limit, Math.max(1, Math.floor(value)));
}

/**
 * Teto de seleções de um grupo. Sem `maxSelect` válido o grupo não tem limite
 * (Infinity) — usado tanto no render (radio × checkbox) quanto no bloqueio.
 */
function groupMaxSelect(group: ProductOptionGroup): number {
  const max = Number(group.maxSelect);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
}

/**
 * Piso de seleções de um grupo. Grupo obrigatório sempre exige ao menos 1
 * opção, mesmo quando `minSelect` não foi configurado.
 */
function groupMinSelect(group: ProductOptionGroup): number {
  const min = Number(group.minSelect);
  const parsed = Number.isFinite(min) && min > 0 ? Math.floor(min) : 0;
  return group.required ? Math.max(1, parsed) : parsed;
}

/** Grupo de escolha única (radio) — teto de 1 opção. */
function isSingleChoiceGroup(group: ProductOptionGroup): boolean {
  return groupMaxSelect(group) === 1;
}

/**
 * Instrução exibida abaixo do título do grupo (ex.: "Escolha 1 opção",
 * "Escolha até 3 opções"). É sempre mostrada — a descrição do grupo, quando
 * existir, aparece como linha de apoio adicional.
 */
function describeGroupRequirement(min: number, max: number): string {
  if (max === 1) {
    return min > 0 ? "Escolha 1 opção" : "Escolha 1 opção (opcional)";
  }
  if (max === Infinity) {
    return min > 0
      ? `Escolha pelo menos ${min} ${min === 1 ? "opção" : "opções"}`
      : "Escolha quantas quiser";
  }
  if (min > 0 && min === max) {
    return `Escolha ${min} ${min === 1 ? "opção" : "opções"}`;
  }
  if (min > 0) return `Escolha de ${min} a ${max} opções`;
  return `Escolha até ${max} opções`;
}

export function ProductModal({
  product,
  onClose,
  initialQuantity,
  halfHalfOptions,
}: ProductModalProps) {
  const { addCustomItem } = useCart();
  const groups = useMemo(() => product?.option_groups ?? [], [product]);
  const flavorOptions = useMemo(() => halfHalfOptions ?? [], [halfHalfOptions]);
  const allowHalfHalf = product?.allow_half_half === true;

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
    for (const g of initialGroups) initial[g.id] = [];
    return initial;
  });
  const [notes, setNotes] = useState("");
  const [quantity, setQuantity] = useState(() =>
    normalizeInitialQuantity(initialQuantity, maxQuantity)
  );
  const [triedSubmit, setTriedSubmit] = useState(false);
  // Modo de preparo: "Inteira" (padrão) ou "Meio a meio".
  const [halfMode, setHalfMode] = useState<HalfHalfMode>("whole");
  // 2º sabor escolhido (o 1º é sempre o produto aberto no modal).
  const [secondFlavorId, setSecondFlavorId] = useState<string | null>(null);

  // Redefine o estado durante a renderização se o produto mudar (padrão recomendado pelo React)
  if (product?.id !== prevProductId) {
    setPrevProductId(product?.id);
    const newInitial: Record<string, string[]> = {};
    for (const g of groups) newInitial[g.id] = [];
    setSelection(newInitial);
    setNotes("");
    setQuantity(normalizeInitialQuantity(initialQuantity, maxQuantity));
    setTriedSubmit(false);
    setHalfMode("whole");
    setSecondFlavorId(null);
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

  // Meio a meio: o produto aberto no modal é sempre o 1º sabor; o cliente
  // escolhe apenas o 2º quando seleciona "2 Sabores (Meio a meio)".
  const halfHalfMode = allowHalfHalf && halfMode === "half";
  const firstHalfFlavor = useMemo(
    () => (allowHalfHalf ? toHalfHalfFlavor(product) : null),
    [allowHalfHalf, product]
  );
  const secondHalfFlavor = useMemo(() => {
    if (!halfHalfMode) return null;
    const flavor = flavorOptions.find((option) => option.id === secondFlavorId);
    return flavor ? toHalfHalfFlavor(flavor) : null;
  }, [halfHalfMode, flavorOptions, secondFlavorId]);
  const selectedHalfFlavors = useMemo(
    () =>
      halfHalfMode
        ? buildHalfHalfFlavors(firstHalfFlavor, secondHalfFlavor)
        : undefined,
    [halfHalfMode, firstHalfFlavor, secondHalfFlavor]
  );

  const halfHalfBasePrice = selectedHalfFlavors
    ? resolveHalfHalfBasePrice(selectedHalfFlavors)
    : null;
  // Só bloqueia quando o modo meio a meio está ativo e falta o 2º sabor.
  const halfHalfInvalid = halfHalfMode && !selectedHalfFlavors;

  const basePrice = halfHalfMode
    ? halfHalfBasePrice ?? 0
    : product?.preco ?? 0;
  // Produto sem preço definido (0/nulo) = "Sob Consulta" no catálogo.
  // No meio a meio o valor vem dos sabores (sabor mais caro).
  const priceOnRequest = halfHalfMode
    ? halfHalfBasePrice === null
    : isPriceOnRequest(product?.preco);
  const unitPrice = basePrice + selectedOptions.reduce((a, o) => a + o.price, 0);
  const totalPrice = unitPrice * quantity;
  // Grupos que ainda não atingiram a quantidade mínima de seleções (o botão
  // "Adicionar" fica bloqueado enquanto existir algum).
  const invalidGroups = groups.filter(
    (g) => (selection[g.id]?.length ?? 0) < groupMinSelect(g)
  );
  const hasInvalidSelection = halfHalfInvalid || invalidGroups.length > 0;

  const handleSubmit = () => {
    if (!product) return;
    if (soldOut) return;
    if (hasInvalidSelection) {
      setTriedSubmit(true);
      if (halfHalfInvalid) {
        const target = document.getElementById("half-half-group");
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target
          ?.querySelector<HTMLInputElement>("input:not(:disabled)")
          ?.focus({ preventScroll: true });
        return;
      }
      const target = document.getElementById("group-" + invalidGroups[0].id);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      // Foca a primeira opção habilitada do grupo pendente (acessibilidade).
      target
        ?.querySelector<HTMLInputElement>("input:not(:disabled)")
        ?.focus({ preventScroll: true });
      return;
    }
    addCustomItem({
      productId: product.id,
      productName: product.nome,
      basePrice,
      imageUrl: product.image_url,
      establishmentId: product.establishmentId,
      categoryName: product.category ?? product.categoria,
      selectedOptions,
      notes: notes.trim(),
      quantidade: quantity,
      // Inteira: sem sabores (preço normal do produto). Meio a meio: o par
      // [produto aberto, 2º sabor] congela o preço do sabor mais caro.
      ...(selectedHalfFlavors ? { halfHalfFlavors: selectedHalfFlavors } : {}),
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
          {allowHalfHalf && (
            <fieldset
              aria-describedby="half-half-mode-hint"
              className="mb-4 rounded-2xl border border-gray-200/80 bg-gray-50/60 p-3.5 dark:border-gray-700/60 dark:bg-gray-800/40"
            >
              <legend className="px-1 text-sm font-bold dark:text-white">
                Como você quer o item?
              </legend>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <label
                  className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-sm transition ${
                    halfHalfMode
                      ? "border-gray-200 bg-white/70 hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-500"
                      : "border-gray-900 bg-white ring-1 ring-gray-900 dark:border-yellow-400 dark:bg-gray-900 dark:ring-yellow-400"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="half-half-mode"
                      checked={!halfHalfMode}
                      onChange={() => {
                        setHalfMode("whole");
                        setSecondFlavorId(null);
                      }}
                      className="h-4 w-4 accent-gray-900 dark:accent-yellow-400"
                    />
                    <span className="font-bold dark:text-gray-100">1 Sabor</span>
                  </span>
                  <span className="pl-6 text-xs font-semibold text-gray-500 dark:text-gray-400">
                    Inteira
                  </span>
                </label>
                <label
                  className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-sm transition ${
                    halfHalfMode
                      ? "border-gray-900 bg-white ring-1 ring-gray-900 dark:border-yellow-400 dark:bg-gray-900 dark:ring-yellow-400"
                      : "border-gray-200 bg-white/70 hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-500"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="half-half-mode"
                      checked={halfHalfMode}
                      onChange={() => setHalfMode("half")}
                      className="h-4 w-4 accent-gray-900 dark:accent-yellow-400"
                    />
                    <span className="font-bold dark:text-gray-100">2 Sabores</span>
                  </span>
                  <span className="pl-6 text-xs font-semibold text-gray-500 dark:text-gray-400">
                    Meio a meio
                  </span>
                </label>
              </div>
              <p
                id="half-half-mode-hint"
                className="mt-1.5 text-xs text-gray-500 dark:text-gray-400"
              >
                Na inteira, o item vai para a sacola com o preço normal. No meio
                a meio, o preço é o do sabor mais caro.
              </p>
            </fieldset>
          )}

          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold uppercase tracking-wider text-xs text-gray-400">
              {halfHalfMode ? "Preço do meio a meio" : "Preço base"}
            </span>
            {halfHalfMode ? (
              halfHalfInvalid ? (
                <span className="text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-300">
                  Escolha o 2º sabor
                </span>
              ) : priceOnRequest ? (
                <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  Sob Consulta
                </span>
              ) : (
                <span className="font-bold tabular-nums dark:text-white">
                  {formatBRL(halfHalfBasePrice ?? 0)}
                </span>
              )
            ) : priceOnRequest ? (
              <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                Sob Consulta
              </span>
            ) : (
              <span className="font-bold tabular-nums dark:text-white">
                {formatBRL(product.preco)}
              </span>
            )}
          </div>
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
          {halfHalfMode && (
            <fieldset
              id="half-half-group"
              aria-describedby="half-half-hint"
              className={`mt-4 rounded-2xl border p-3.5 transition-colors ${
                halfHalfInvalid && triedSubmit
                  ? "border-red-400 bg-red-50/70 dark:border-red-500/60 dark:bg-red-500/10"
                  : "border-amber-300/70 bg-amber-50/60 dark:border-amber-400/40 dark:bg-amber-400/10"
              }`}
            >
              <legend className="px-1 text-sm font-bold dark:text-white">
                Monte meio a meio{" "}
                <span className="ml-1 rounded-full bg-gray-900 px-2 py-0.5 text-[10px] uppercase text-white dark:bg-yellow-400 dark:text-gray-950">
                  Obrigatório
                </span>
                <span
                  className={`ml-1.5 text-[11px] font-semibold tabular-nums ${
                    halfHalfInvalid
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {selectedHalfFlavors?.length ?? 1}/{HALF_HALF_FLAVOR_COUNT}
                </span>
              </legend>
              <p
                id="half-half-hint"
                className="mb-2 mt-1 text-xs font-semibold text-gray-600 dark:text-gray-300"
              >
                O 1º sabor é {product.nome}. Escolha o 2º sabor da categoria{" "}
                {product.category ?? product.categoria}. O preço é o do sabor
                mais caro.
              </p>

              {/* 1º sabor: fixo no produto aberto no modal. */}
              <div className="flex items-center gap-3 rounded-xl border border-gray-900 bg-white px-3 py-2.5 text-sm ring-1 ring-gray-900 dark:border-yellow-400 dark:bg-gray-900 dark:ring-yellow-400">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[10px] font-bold text-white dark:bg-yellow-400 dark:text-gray-950">
                  1
                </span>
                <span className="flex-1 font-medium dark:text-gray-100">
                  {product.nome}
                </span>
                <span className="text-xs font-bold tabular-nums text-gray-500 dark:text-gray-400">
                  {isPriceOnRequest(product.preco)
                    ? "Sob consulta"
                    : formatBRL(product.preco)}
                </span>
              </div>

              <p className="mb-1.5 mt-2 text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                2º sabor
              </p>

              {flavorOptions.length === 0 ? (
                <p className="rounded-lg bg-amber-100 px-2.5 py-1.5 text-xs font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  Nenhum outro sabor desta categoria está habilitado para meio a
                  meio. Escolha &quot;1 Sabor (Inteira)&quot; ou outro item do
                  cardápio.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {flavorOptions.map((flavor) => {
                    const checked = secondFlavorId === flavor.id;
                    return (
                      <label
                        key={flavor.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition ${
                          checked
                            ? "border-gray-900 bg-white ring-1 ring-gray-900 dark:border-yellow-400 dark:bg-gray-900 dark:ring-yellow-400"
                            : "border-gray-200 bg-white/70 hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-500"
                        }`}
                      >
                        <input
                          type="radio"
                          name="half-half-second-flavor"
                          checked={checked}
                          onChange={() => setSecondFlavorId(flavor.id)}
                          className="h-4 w-4 accent-gray-900 dark:accent-yellow-400"
                        />
                        <span className="flex-1 font-medium dark:text-gray-100">
                          {flavor.nome}
                        </span>
                        <span className="text-xs font-bold tabular-nums text-gray-500 dark:text-gray-400">
                          {isPriceOnRequest(flavor.preco)
                            ? "Sob consulta"
                            : formatBRL(flavor.preco)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              {selectedHalfFlavors && (
                <p className="mt-2 rounded-lg bg-white/80 px-2.5 py-1.5 text-xs font-semibold text-gray-700 dark:bg-gray-900/60 dark:text-gray-200">
                  {halfHalfFlavorsLabel(selectedHalfFlavors)}
                  {halfHalfBasePrice == null
                    ? " · Sob consulta"
                    : ` · ${formatBRL(halfHalfBasePrice)}`}
                </p>
              )}
              {halfHalfInvalid && (
                <p
                  role={triedSubmit ? "alert" : undefined}
                  className={`mt-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                    triedSubmit
                      ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
                      : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {flavorOptions.length === 0
                    ? "Escolha “1 Sabor (Inteira)” para adicionar este item."
                    : "Escolha o 2º sabor para continuar."}
                </p>
              )}
            </fieldset>
          )}

          {groups.map((g) => {
            const selectedCount = selection[g.id]?.length ?? 0;
            const min = groupMinSelect(g);
            const max = groupMaxSelect(g);
            const single = isSingleChoiceGroup(g);
            const isRequired = g.required || min > 0;
            const groupInvalid = selectedCount < min;
            const highlightInvalid = groupInvalid && triedSubmit;
            const hint = describeGroupRequirement(min, max);
            const groupDescription = g.description?.trim() || "";
            const remaining = Math.max(0, min - selectedCount);
            return (
              <fieldset
                key={g.id}
                id={`group-${g.id}`}
                aria-describedby={`group-${g.id}-hint`}
                className={`mt-4 rounded-2xl border p-3.5 transition-colors ${
                  highlightInvalid
                    ? "border-red-400 bg-red-50/70 dark:border-red-500/60 dark:bg-red-500/10"
                    : "border-gray-200/80 bg-gray-50/60 dark:border-gray-700/60 dark:bg-gray-800/40"
                }`}
              >
                <legend className="px-1 text-sm font-bold dark:text-white">
                  {g.title}{" "}
                  {isRequired ? <span className="ml-1 rounded-full bg-gray-900 px-2 py-0.5 text-[10px] uppercase text-white dark:bg-yellow-400 dark:text-gray-950">Obrigatório</span> : <span className="ml-1 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] uppercase text-gray-500 dark:bg-gray-700 dark:text-gray-300">Opcional</span>}
                  {Number.isFinite(max) && (
                    <span className={`ml-1.5 text-[11px] font-semibold tabular-nums ${groupInvalid ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}`}>{selectedCount}/{max}</span>
                  )}
                </legend>
                <div className="mb-2 mt-1 space-y-0.5">
                  <p id={`group-${g.id}-hint`} className="text-xs font-semibold text-gray-600 dark:text-gray-300">{hint}</p>
                  {groupDescription && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">{groupDescription}</p>
                  )}
                </div>
                {groupInvalid && (
                  <p
                    role={highlightInvalid ? "alert" : undefined}
                    className={`mb-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${highlightInvalid ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300" : "text-amber-600 dark:text-amber-400"}`}
                  >
                    {`Faltam ${remaining} ${remaining === 1 ? "seleção" : "seleções"} para completar este grupo.`}
                  </p>
                )}
                <div className="flex flex-col gap-1.5">
                  {g.options.map((o) => {
                    const checked = selection[g.id]?.includes(o.id) ?? false;
                    // O limite só bloqueia grupos de múltipla escolha, e nunca a
                    // opção marcada (para poder desmarcar e liberar espaço). Em
                    // grupos de escolha única nada fica `disabled`: o cliente
                    // sempre pode trocar a opção (ex.: 120 g → 240 g).
                    const atLimit = !single && !checked && selectedCount >= max;
                    return (
                      <label key={o.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition ${checked ? "border-gray-900 bg-white ring-1 ring-gray-900 dark:border-yellow-400 dark:bg-gray-900 dark:ring-yellow-400" : "border-gray-200 bg-white/70 dark:border-gray-700 dark:bg-gray-900/40"} ${atLimit ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-gray-400 dark:hover:border-gray-500"}`}>
                        <input
                          type={single ? "radio" : "checkbox"}
                          name={g.id}
                          checked={checked}
                          disabled={atLimit}
                          onChange={() => setSelection((p) => {
                            const cur = p[g.id] ?? [];
                            // Escolha única: a nova opção substitui a anterior
                            // (comportamento nativo de radio button).
                            if (single) return { ...p, [g.id]: [o.id] };
                            if (cur.includes(o.id)) return { ...p, [g.id]: cur.filter((x) => x !== o.id) };
                            if (cur.length >= max) return p;
                            return { ...p, [g.id]: [...cur, o.id] };
                          })}
                          onClick={single && min === 0 ? (event) => {
                            // Clicar num radio JÁ marcado não dispara `onChange`.
                            // Em grupos opcionais isso limpa a seleção.
                            if (!checked) return;
                            event.preventDefault();
                            setSelection((p) => ({ ...p, [g.id]: [] }));
                          } : undefined}
                          className="h-4 w-4 accent-gray-900 disabled:cursor-not-allowed dark:accent-yellow-400"
                        />
                        <span className="flex-1 font-medium dark:text-gray-100">{o.name}</span>
                        <span className="text-xs font-bold tabular-nums text-gray-500 dark:text-gray-400">{o.price > 0 ? `+ ${formatBRL(o.price)}` : "Incluso"}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
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
                {quantity} {quantity === 1 ? "item" : "itens"} ×{" "}
                {halfHalfInvalid
                  ? "Escolha o 2º sabor"
                  : priceOnRequest
                    ? "Sob consulta"
                    : formatBRL(unitPrice)}
              </span>
              <span className="font-bold tabular-nums text-gray-900 dark:text-white">
                {halfHalfInvalid
                  ? "—"
                  : priceOnRequest
                    ? "Sob consulta"
                    : formatBRL(totalPrice)}
              </span>
            </div>
          </div>
          <div className={hasInvalidSelection ? "h-36" : "h-24"} />
        </div>
        <div className="absolute inset-x-0 bottom-0 border-t bg-white/95 px-4 pb-6 pt-3 backdrop-blur dark:bg-gray-900/95">
          {hasInvalidSelection && (triedSubmit || invalidGroups.length > 0) && (
            <p
              role="status"
              aria-live="polite"
              className={`mb-2 rounded-lg px-3 py-2 text-xs font-semibold ${triedSubmit ? "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300" : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"}`}
            >
              {triedSubmit
                ? `Complete a seleção para continuar: ${[
                    ...(halfHalfInvalid ? ["o 2º sabor do meio a meio"] : []),
                    ...invalidGroups.map((g) => g.title),
                  ].join(", ")}.`
                : halfHalfInvalid
                  ? "Escolha o 2º sabor do meio a meio para adicionar ao carrinho."
                  : "Selecione as opções obrigatórias para adicionar ao carrinho."}
            </p>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={soldOut}
            className="w-full rounded-xl bg-gray-900 px-4 py-3.5 text-sm font-bold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:cursor-not-allowed disabled:bg-gray-400 disabled:text-gray-100 disabled:hover:bg-gray-400 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:disabled:bg-gray-700 dark:disabled:text-gray-400 dark:disabled:hover:bg-gray-700"
          >
            {soldOut
              ? "Esgotado"
              : halfHalfInvalid
                ? "Escolha o 2º sabor"
                : priceOnRequest
                  ? "Adicionar ao Carrinho · Sob Consulta"
                  : `Adicionar ao Carrinho - ${formatBRL(totalPrice)}`}
          </button>
        </div>
      </div>
    </div>
  );
}