"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Category, MenuAddon, MenuData, MenuProduct } from "@/lib/types";
import { compareByOrder } from "@/lib/menuOrder";
import { useEstablishment } from "./useEstablishment";
import { ProductFormModal } from "./ProductFormModal";
import { CategoriesModal } from "./CategoriesModal";
import { AddonsModal } from "./AddonsModal";
import { DeleteProductModal } from "./DeleteProductModal";
import { AdminHeader } from "../components/AdminHeader";

/** Formata número como BRL (ex: 26.9 → "R$ 26,90"). */
function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

/**
 * Conteúdo interativo da Gestão de Cardápio/Produtos (Client Component).
 *
 * A página (`page.tsx`) é um Server Component com `instant = false`; a
 * interatividade e o consumo das rotas /api/products e /api/categories vivem
 * aqui. Um super admin escolhe o estabelecimento no topo; um admin trabalha
 * sempre no seu próprio estabelecimento (resolvido via RLS).
 */
export function PainelProdutos() {
  const {
    establishments,
    selectedId: establishmentId,
    isSuperAdmin,
    isLoading: isLoadingEstablishments,
    error: establishmentError,
    select,
  } = useEstablishment();

  // Dados do cardápio.
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<MenuProduct[]>([]);
  const [addons, setAddons] = useState<MenuAddon[]>([]);
  const [isLoadingMenu, setIsLoadingMenu] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);

  // Filtro visual por categoria ("todas" ou um id de categoria) e busca.
  const [categoryFilter, setCategoryFilter] = useState<string>("todas");
  const [query, setQuery] = useState("");

  // Modais de produto/categoria/adicionais.
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<MenuProduct | null>(null);
  const [isCategoriesModalOpen, setIsCategoriesModalOpen] = useState(false);
  const [addonsTarget, setAddonsTarget] = useState<MenuProduct | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MenuProduct | null>(null);
  /** Carrega categorias e produtos do estabelecimento selecionado. */
  const fetchMenu = useCallback(async () => {
    if (!establishmentId) return;
    setIsLoadingMenu(true);
    setMenuError(null);
    try {
      const res = await fetch(
        `/api/products?establishment_id=${encodeURIComponent(establishmentId)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao carregar o cardápio.");
      }
      const menu = data as MenuData;
      setCategories(menu.categories ?? []);
      setProducts(menu.products ?? []);
      setAddons(menu.addons ?? []);
    } catch (err) {
      setCategories([]);
      setProducts([]);
      setAddons([]);
      setMenuError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsLoadingMenu(false);
    }
  }, [establishmentId]);

  // Recarrega o cardápio quando o estabelecimento selecionado muda.
  // (IIFE assíncrona, espelhando admin/page.tsx; `fetchMenu` só altera estado
  // após o primeiro await.)
  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await fetchMenu();
    })();
    return () => {
      active = false;
    };
  }, [fetchMenu]);

  // Ajusta o filtro durante o render quando o estabelecimento muda (evita um
  // efeito só para resetar; padrão recomendado pelo React para "ajustar estado
  // quando uma prop muda").
  const [prevEstablishmentId, setPrevEstablishmentId] =
    useState(establishmentId);
  if (establishmentId !== prevEstablishmentId) {
    setPrevEstablishmentId(establishmentId);
    setCategoryFilter("todas");
  }

  /** Mapa id→categoria para exibir o nome na tabela (fallback local). */
  const categoryName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  /** Nome da categoria de um produto (prioriza `category_name` vindo da API). */
  const getCategoryName = (product: MenuProduct): string => {
    if (product.category_name) return product.category_name;
    if (!product.category_id) return "Sem categoria";
    return categoryName.get(product.category_id) ?? "Sem categoria";
  };

  /** Produtos filtrados por categoria e busca textual. */
  const filteredProducts = useMemo(() => {
    const term = query.trim().toLowerCase();
    return products
      .filter(
        (p) => categoryFilter === "todas" || p.category_id === categoryFilter
      )
      .filter((p) => {
        if (!term) return true;
        return (
          p.name.toLowerCase().includes(term) ||
          p.description.toLowerCase().includes(term)
        );
      })
      .sort(compareByOrder);
  }, [products, categoryFilter, query]);

  const openCreate = () => {
    setEditingProduct(null);
    setMenuError(null);
    setIsProductModalOpen(true);
  };

  const openEdit = (product: MenuProduct) => {
    setEditingProduct(product);
    setMenuError(null);
    setIsProductModalOpen(true);
  };

  const openDelete = (product: MenuProduct) => setDeleteTarget(product);

  /** Abre o modal de adicionais (opcionais) do produto. */
  const openAddons = (product: MenuProduct) => {
    setMenuError(null);
    setAddonsTarget(product);
  };

  /**
   * Liga/desliga o status `is_active` de um produto (pausar item esgotado).
   * Usa o PUT /api/products enviando apenas `{ id, is_active }`.
   * Atualiza de forma otimista e reverte em caso de erro.
   */
  const handleToggleActive = useCallback(
    async (product: MenuProduct, next: boolean) => {
      const previous = product.is_active;
      // Otimista: reflete imediatamente na lista.
      setProducts((prev) =>
        prev.map((p) => (p.id === product.id ? { ...p, is_active: next } : p))
      );
      try {
        const res = await fetch("/api/products", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: product.id, is_active: next }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error ?? "Falha ao atualizar o status.");
        }
      } catch (err) {
        // Reverte a mudança otimista.
        setProducts((prev) =>
          prev.map((p) => (p.id === product.id ? { ...p, is_active: previous } : p))
        );
        setMenuError(err instanceof Error ? err.message : "Erro inesperado.");
      }
    },
    []
  );

  /** Exclui um produto (DELETE /api/products). */
  const handleDelete = useCallback(async (product: MenuProduct) => {
    try {
      const res = await fetch("/api/products", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao excluir o produto.");
      }
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
    } catch (err) {
      setMenuError(err instanceof Error ? err.message : "Erro inesperado.");
    }
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-gray-950">
      <AdminHeader establishmentId={establishmentId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        {/* Título + seletor de estabelecimento (apenas super admin alterna) */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Cardápio do Estabelecimento
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Crie categorias, adicione itens e pause produtos esgotados.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {/* Seletor de estabelecimento (dropdown só p/ super admin) */}
            <div>
              <label
                htmlFor="estabelecimento"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500"
              >
                Estabelecimento
              </label>
              {isSuperAdmin ? (
                <select
                  id="estabelecimento"
                  value={establishmentId ?? ""}
                  onChange={(e) => select(e.target.value)}
                  disabled={isLoadingEstablishments || establishments.length === 0}
                  className="min-w-56 rounded-xl border border-gray-800 bg-gray-900/50 px-3 py-2.5 text-sm text-gray-200 outline-none transition focus:border-yellow-400/60 disabled:opacity-60"
                >
                  {establishments.map((est) => (
                    <option key={est.id} value={est.id}>
                      {est.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="min-w-56 rounded-xl border border-gray-800 bg-gray-900/50 px-3 py-2.5 text-sm text-gray-300">
                  {establishments[0]?.name ?? "—"}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsCategoriesModalOpen(true)}
              disabled={!establishmentId}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Categorias
            </button>
            <button
              type="button"
              onClick={openCreate}
              disabled={!establishmentId}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Novo Produto
            </button>
          </div>
        </div>

        {/* Erros de carregamento (estabelecimento ou cardápio) */}
        {(establishmentError || menuError) && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3"
          >
            <p className="text-sm font-medium text-red-400">
              {establishmentError ?? menuError}
            </p>
            <button
              type="button"
              onClick={() => {
                setMenuError(null);
                void fetchMenu();
              }}
              className="shrink-0 rounded-lg border border-red-500/30 px-3 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {/* Filtro visual por categoria (chips) + busca */}
        <div className="flex flex-col gap-3">
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Filtrar por categoria"
          >
            <button
              type="button"
              onClick={() => setCategoryFilter("todas")}
              className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                categoryFilter === "todas"
                  ? "border-yellow-400/40 bg-yellow-400/15 text-yellow-300"
                  : "border-gray-700 text-gray-300 hover:border-yellow-400/50 hover:text-white"
              }`}
            >
              Todas
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategoryFilter(cat.id)}
                className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                  categoryFilter === cat.id
                    ? "border-yellow-400/40 bg-yellow-400/15 text-yellow-300"
                    : "border-gray-700 text-gray-300 hover:border-yellow-400/50 hover:text-white"
                }`}
              >
                {cat.name}
                <span className="ml-1.5 text-xs font-normal tabular-nums text-gray-500">
                  {products.filter((p) => p.category_id === cat.id).length}
                </span>
              </button>
            ))}
          </div>

          <div className="relative sm:max-w-xs">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar produto..."
              className="w-full rounded-xl border border-gray-800 bg-gray-900/50 py-2.5 pl-10 pr-3 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60"
            />
          </div>
        </div>

        {/* Estados: carregando / vazio / lista */}
        {isLoadingMenu ? (
          <ul className="space-y-3" aria-busy="true" aria-label="Carregando produtos">
            {Array.from({ length: 5 }).map((_, i) => (
              <li
                key={i}
                className="h-16 animate-pulse rounded-2xl border border-gray-800 bg-gray-900/50"
              />
            ))}
          </ul>
        ) : filteredProducts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-gray-800 bg-gray-900/30 px-6 py-12 text-center">
            <svg
              aria-hidden="true"
              className="h-10 w-10 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-gray-300">
              {query || categoryFilter !== "todas"
                ? "Nenhum produto encontrado para os filtros aplicados."
                : "Nenhum produto cadastrado ainda."}
            </p>
            {!query && categoryFilter === "todas" && (
              <button
                type="button"
                onClick={openCreate}
                disabled={!establishmentId}
                className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 disabled:opacity-50"
              >
                Cadastrar o primeiro produto
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Tabela (desktop) */}
            <div className="hidden overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/50 md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-gray-800 bg-gray-900/60 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Produto</th>
                    <th className="px-5 py-3 font-semibold">Categoria</th>
                    <th className="px-5 py-3 font-semibold">Preço</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 text-right font-semibold">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {filteredProducts.map((product) => (
                    <ProductRow
                      key={product.id}
                      product={product}
                      categoryName={getCategoryName(product)}
                      addonsCount={addons.filter(
                        (a) => a.product_id === product.id && a.is_active
                      ).length}
                      onEdit={() => openEdit(product)}
                      onAddons={() => openAddons(product)}
                      onDelete={() => openDelete(product)}
                      onToggle={(next) => void handleToggleActive(product, next)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cards (mobile) */}
            <ul className="space-y-3 md:hidden">
              {filteredProducts.map((product) => (
                <li
                  key={product.id}
                  className="rounded-2xl border border-gray-800 bg-gray-900/50 p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-gray-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={product.image_url || "/window.svg"}
                        alt={product.name}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-gray-100">
                        {product.name}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-400">
                        {getCategoryName(product)}
                      </p>
                      <p className="mt-1 text-sm font-bold tabular-nums text-yellow-300">
                        {formatBRL(product.price)}
                      </p>
                    </div>
                    <ActiveToggle
                      active={product.is_active}
                      onToggle={(next) => void handleToggleActive(product, next)}
                    />
                  </div>
                  <div className="mt-3 flex items-center gap-2 border-t border-gray-800 pt-3">
                    <button
                      type="button"
                      onClick={() => openAddons(product)}
                      className="flex-1 rounded-lg border border-gray-700 py-2 text-xs font-semibold text-gray-200 transition hover:bg-gray-800"
                    >
                      Adicionais
                      {addons.filter((a) => a.product_id === product.id && a.is_active)
                        .length > 0 && (
                        <span className="ml-1.5 tabular-nums text-gray-500">
                          (
                          {addons.filter(
                            (a) => a.product_id === product.id && a.is_active
                          ).length}
                          )
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(product)}
                      className="flex-1 rounded-lg border border-gray-700 py-2 text-xs font-semibold text-gray-200 transition hover:bg-gray-800"
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => openDelete(product)}
                      className="flex-1 rounded-lg border border-red-500/30 py-2 text-xs font-semibold text-red-400 transition hover:bg-red-500/10"
                    >
                      Excluir
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
      {/* Modais */}
      {isProductModalOpen && establishmentId && (
        <ProductFormModal
          establishmentId={establishmentId}
          isSuperAdmin={isSuperAdmin}
          categories={categories}
          editing={editingProduct}
          onClose={() => {
            setIsProductModalOpen(false);
            setEditingProduct(null);
          }}
          onSubmitDone={() => {
            setIsProductModalOpen(false);
            setEditingProduct(null);
            void fetchMenu();
          }}
        />
      )}

      {isCategoriesModalOpen && establishmentId && (
        <CategoriesModal
          establishmentId={establishmentId}
          isSuperAdmin={isSuperAdmin}
          categories={categories}
          onClose={() => setIsCategoriesModalOpen(false)}
          onChanged={() => void fetchMenu()}
        />
      )}

      {addonsTarget && establishmentId && (
        <AddonsModal
          establishmentId={establishmentId}
          isSuperAdmin={isSuperAdmin}
          product={addonsTarget}
          addons={addons}
          onClose={() => setAddonsTarget(null)}
          onChanged={() => void fetchMenu()}
        />
      )}

      {deleteTarget && (
        <DeleteProductModal
          product={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const target = deleteTarget;
            setDeleteTarget(null);
            await handleDelete(target);
          }}
        />
      )}
    </div>
  );
}

/**
 * Toggle Ativo/Pausado de um produto.
 * `active = true` → "Disponível" (verde); `false` → "Pausado" (cinza).
 * Clicar inverte o estado (chama onToggle com o próximo valor).
 */
function ActiveToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      role="switch"
      aria-checked={active}
      aria-label={active ? "Pausar produto" : "Ativar produto"}
      title={active ? "Pausar (esgotado)" : "Ativar (disponível)"}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-125 ${
        active
          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
          : "border-gray-600/50 bg-gray-600/30 text-gray-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          active ? "bg-emerald-400" : "bg-gray-500"
        }`}
      />
      {active ? "Disponível" : "Pausado"}
    </button>
  );
}

/** Ícone de ação compacto (editar/excluir) usado nas linhas da tabela. */
function ActionIcon({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`rounded-lg p-2 transition ${
        danger
          ? "text-red-400 hover:bg-red-500/10"
          : "text-gray-400 hover:bg-gray-700/40 hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Linha da tabela de produtos (desktop): foto, nome, categoria, preço,
 * toggle de status e ações (editar/excluir).
 */
function ProductRow({
  product,
  categoryName,
  addonsCount,
  onEdit,
  onAddons,
  onDelete,
  onToggle,
}: {
  product: MenuProduct;
  categoryName: string;
  /** Quantidade de adicionais ativos do produto (badge no botão). */
  addonsCount: number;
  onEdit: () => void;
  onAddons: () => void;
  onDelete: () => void;
  onToggle: (next: boolean) => void;
}) {
  return (
    <tr className="transition hover:bg-gray-900/40">
      <td className="px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-gray-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={product.image_url || "/window.svg"}
              alt={product.name}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-gray-100">{product.name}</p>
            {product.description && (
              <p className="max-w-xs truncate text-xs text-gray-500">
                {product.description}
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="px-5 py-3">
        <span className="inline-flex rounded-full border border-gray-700 bg-gray-800/50 px-2.5 py-0.5 text-xs font-medium text-gray-300">
          {categoryName}
        </span>
      </td>
      <td className="px-5 py-3 font-bold tabular-nums text-yellow-300">
        {formatBRL(product.price)}
      </td>
      <td className="px-5 py-3">
        <ActiveToggle active={product.is_active} onToggle={onToggle} />
      </td>
      <td className="px-5 py-3">
        <div className="flex items-center justify-end gap-1">
          <ActionIcon label={`Gerenciar adicionais de ${product.name}`} onClick={onAddons}>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold">
              {addonsCount} {addonsCount === 1 ? "adicional" : "adicionais"}
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </span>
          </ActionIcon>
          <ActionIcon label={`Editar ${product.name}`} onClick={onEdit}>
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </ActionIcon>
          <ActionIcon label={`Excluir ${product.name}`} onClick={onDelete} danger>
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </ActionIcon>
        </div>
      </td>
    </tr>
  );
}


