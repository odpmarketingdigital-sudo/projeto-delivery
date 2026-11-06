"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import type {
  MenuAddon,
  Product,
  ProductOptionGroup,
  StorefrontMenu,
} from "@/lib/types";
import { sortByOrder } from "@/lib/menuOrder";
import { describeNextOpening, isStoreOpen } from "@/lib/openingHours";
import { ProductCard } from "@/app/components/ProductCard";
import { ProductModal } from "@/app/components/ProductModal";
import { CartSummary } from "@/app/components/CartSummary";
import { CartDrawer } from "@/app/components/CartDrawer";
import {
  BOTTOM_NAV_FIXED_CONTAINER,
  StorefrontBottomNav,
  scrollPageToTop,
} from "@/app/components/StorefrontBottomNav";
import { useCart } from "@/context/CartContext";
import { useTrackableOrder } from "@/app/components/useTrackableOrder";
import { useIsMounted } from "@/app/components/useIsMounted";

const slugify = (value: string) =>
  `categoria-${value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;

/**
 * Monta os grupos de opções do modal a partir dos adicionais cadastrados no
 * painel. Todos os adicionais são opcionais (múltipla escolha): o cliente
 * decide se quer incluir. Retorna `[]` quando o produto não tem adicionais —
 * nesse caso o modal exibe apenas observações e a quantidade.
 */
function buildOptionGroups(
  productId: string,
  addons: MenuAddon[]
): ProductOptionGroup[] {
  const active = sortByOrder(
    addons.filter((a) => a.product_id === productId && a.is_active)
  );
  if (active.length === 0) return [];

  return [
    {
      id: `${productId}-optional`,
      title: "Adicionais",
      required: false,
      options: active.map((a) => ({
        id: a.id,
        name: a.name,
        price: a.price,
      })),
    },
  ];
}


/**
 * Vitrine pública do cardápio (Client Component).
 *
 * Reutilizada pela rota `/demo` e pela rota dinâmica por slug (`/[slug]`).
 * Quando `slug` é informado (rota dinâmica), ele tem prioridade; caso
 * contrário, lê `?slug=`/`?establishment_id=` da query string (útil para a
 * demonstração) — e, sem parâmetro, a API devolve a primeira loja ativa.
 */
export default function Storefront({ slug }: { slug?: string } = {}) {
  const { itemCount, removeItem, quantityOf } = useCart();
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  // Chave de remontagem do modal: garante que a quantidade/seleções sejam
  // reiniciadas a cada abertura, mesmo reabrindo o mesmo produto.
  const [modalKey, setModalKey] = useState(0);
  const [currentCategory, setCurrentCategory] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Cardápio dinâmico (API pública /api/menu — não exige sessão).
  const [menu, setMenu] = useState<StorefrontMenu | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Flag de montagem: separa o que só existe no NAVEGADOR (relógio local, fuso
  // do cliente, storage) do HTML gerado no servidor. Sem ela o badge
  // Aberto/Fechado poderia sair diferente no SSR e no primeiro render do
  // cliente (servidor em UTC × fuso do cliente, build estático, minuto de
  // virada de horário) e o React acusaria divergência de hidratação.
  const isMounted = useIsMounted();

  // Relógio local (atualiza a cada minuto) para manter o badge Aberto/Fechado
  // coerente mesmo se o cliente deixar a página aberta durante a transição.
  // O valor só é LIDO depois da montagem (ver `storeStatus`), portanto o
  // objeto criado aqui nunca influencia o markup da hidratação.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Menu condicional "Acompanhar Pedido": só renderiza quando a sessão do
  // cliente (telefone no localStorage) tem pedido em andamento — ou concluído
  // hoje — nesta loja. O link aponta para o pedido ativo mais recente.
  const { orderId: trackOrderId, isLoading: isTrackLoading } =
    useTrackableOrder(slug ?? menu?.establishment?.id ?? null);
  const trackHref = trackOrderId ? `/pedido/${trackOrderId}` : null;

  // Slug público usado nos links do cliente ("Meus Pedidos"). Na vitrine por
  // slug ele vem da rota; no `/demo` (ou `?slug=`) vem da loja carregada pela
  // API — sem slug conhecido o link não é montado (evita `/undefined/pedidos`).
  const publicSlug = slug ?? menu?.establishment.slug ?? null;
  const ordersHref = publicSlug ? `/${publicSlug}/pedidos` : null;

  // Status calculado com o horário de Brasília (o servidor pode rodar em UTC).
  // Exige `isMounted`: o relógio do navegador só é confiável no cliente — no
  // servidor (ou em um build estático) o mesmo texto "Aberto agora"/"Fechado
  // no momento" seria avaliado em outro instante e divergiria na hidratação.
  const storeStatus = useMemo(
    () =>
      isMounted && menu
        ? isStoreOpen(menu.establishment.opening_hours, now)
        : null,
    [isMounted, menu, now]
  );
  const nextOpeningLabel = storeStatus
    ? describeNextOpening(storeStatus.nextOpening)
    : null;

  // Carrega a loja identificada. Prioridade:
  //   1) `slug` vindo da rota dinâmica (prop);
  //   2) `?establishment_id=` / `?slug=` da query string (comportamento legado);
  //   3) sem parâmetro, a API devolve a primeira loja ativa.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const query = new URLSearchParams();
        if (slug) {
          query.set("slug", slug);
        } else {
          const params = new URLSearchParams(window.location.search);
          const establishmentId = params.get("establishment_id");
          const slugParam = params.get("slug");
          if (establishmentId) query.set("establishment_id", establishmentId);
          else if (slugParam) query.set("slug", slugParam);
        }

        const qs = query.toString();
        const res = await fetch(`/api/menu${qs ? `?${qs}` : ""}`);
        const data = (await res.json().catch(() => ({}))) as Partial<
          StorefrontMenu & { error?: string }
        >;
        if (!res.ok) {
          throw new Error(data.error ?? "Falha ao carregar o cardápio.");
        }
        if (!cancelled) {
          setMenu(data as StorefrontMenu);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setMenu(null);
          setLoadError(err instanceof Error ? err.message : "Erro inesperado.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Abre o modal de detalhes. A quantidade é escolhida apenas dentro dele.
  const handleSelect = (product: Product) => {
    setSelectedProduct(product);
    setModalKey((k) => k + 1);
  };

  // Aba "Cardápio" da barra inferior (já ativa nesta tela): volta ao topo
  // (início da listagem de produtos) e fecha o seletor de categorias, sem
  // recarregar a página.
  const showMenu = () => {
    setMenuOpen(false);
    scrollPageToTop();
  };

  // Espaço reservado no fim do conteúdo para a barra inferior fixa. A barra da
  // sacola (`CartSummary`) aparece empilhada acima da navegação e cresce com o
  // aviso de loja fechada — por isso o padding muda junto.
  const storeClosed = storeStatus ? !storeStatus.isOpen : false;
  const contentBottomPadding =
    itemCount > 0 ? (storeClosed ? "pb-56" : "pb-40") : "pb-24";

  // Converte o payload dinâmico (MenuProduct + adicionais) para o formato de
  // exibição do cardápio (Product com option_groups).
  const products = useMemo<Product[]>(() => {
    if (!menu) return [];
    const addonsByProduct = new Map<string, MenuAddon[]>();
    for (const addon of menu.addons) {
      const list = addonsByProduct.get(addon.product_id) ?? [];
      list.push(addon);
      addonsByProduct.set(addon.product_id, list);
    }
    const categoryName = new Map(
      menu.categories.map((category) => [category.id, category.name])
    );

    return menu.products.map((item) => {
      const categoria =
        item.category_name ||
        (item.category_id ? categoryName.get(item.category_id) : null) ||
        "Outros";
      const groups = buildOptionGroups(item.id, addonsByProduct.get(item.id) ?? []);
      return {
        id: item.id,
        nome: item.name,
        descricao: item.description,
        preco: item.price,
        categoria,
        category: categoria,
        image_url: item.image_url || "/window.svg",
        establishmentId: item.establishment_id,
        track_stock: item.track_stock === true,
        stock_quantity: Number(item.stock_quantity) || 0,
        ...(groups.length > 0 ? { option_groups: groups } : {}),
      };
    });
  }, [menu]);

  const categories = useMemo(() => {
    if (!menu) return [];
    const orderedNames = sortByOrder(menu.categories).map((c) => c.name);
    const present = new Set(products.map((p) => p.categoria));
    const extras = [...present].filter((name) => !orderedNames.includes(name));
    return [...orderedNames.filter((name) => present.has(name)), ...extras];
  }, [menu, products]);

  const productsByCategory = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const category of categories) {
      map.set(
        category,
        products.filter((p) => (p.category ?? p.categoria) === category)
      );
    }
    return map;
  }, [categories, products]);

  // Categoria ativa derivada (sem efeito: estado inicial vazio → primeira).
  const activeCategory = currentCategory || categories[0] || "";

  const scrollToCategory = (category: string) => {
    setCurrentCategory(category);
    setMenuOpen(false);
    document
      .getElementById(slugify(category))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
      {/* Topo Visual: Banner + Logo + Nome do Estabelecimento (dinâmico) */}
      {/* Fundo do topo = mesmo cinza do fundo geral (bg-gray-50 / dark:bg-gray-950)
          para não criar uma faixa branca abaixo do banner. */}
      <header className="relative w-full bg-gray-50 pb-2 dark:bg-gray-950">
        {/* Banner de Capa */}
        <div className="relative h-44 w-full overflow-hidden bg-gray-200 sm:h-52 dark:bg-gray-800">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={menu?.establishment.banner_url || "/topo-hamburguer.webp"}
            alt={`Banner de ${menu?.establishment.name ?? "estabelecimento"}`}
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />
        </div>

        {/* Logo Circular + Nome Abaixo */}
        <div className="relative mx-auto -mt-12 flex max-w-2xl flex-col items-center px-4 text-center">
          {/* Anel combina com o fundo cinza do topo (evita halo branco). */}
          <div className="relative h-24 w-24 overflow-hidden rounded-full border-4 border-gray-50 bg-gray-100 shadow-md dark:border-gray-950 dark:bg-gray-800 sm:h-28 sm:w-28">
            {menu?.establishment.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={menu.establishment.logo_url}
                alt={`Logo de ${menu.establishment.name ?? "estabelecimento"}`}
                className="h-full w-full object-cover"
              />
            ) : (
              /* Sem logo cadastrado: avatar neutro (nenhuma marca da plataforma
                 é exibida na vitrine do estabelecimento). */
              <span
                aria-hidden="true"
                className="flex h-full w-full items-center justify-center text-gray-400 dark:text-gray-500"
              >
                <svg
                  className="h-10 w-10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                >
                  <path d="M3 9.5 12 3l9 6.5" />
                  <path d="M5 8.5V21h14V8.5" />
                  <path d="M9.5 21v-6h5v6" />
                </svg>
              </span>
            )}
          </div>

          {/* Nome, Descrição e Badge de Entrega — tudo centralizado */}
          <div className="mt-2.5 flex flex-col items-center justify-center gap-1.5">
            <h1 className="text-2xl font-black tracking-tight text-gray-900 dark:text-white sm:text-3xl">
              {menu?.establishment.name ?? "Cardápio"}
            </h1>

            {menu?.establishment.description ? (
              <p className="max-w-md text-xs font-medium text-gray-500 dark:text-gray-400">
                {menu.establishment.description}
              </p>
            ) : (
              /* Selo padrão — centralizado junto às infos do estabelecimento */
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                >
                  <circle cx="18.5" cy="17.5" r="3.5" />
                  <circle cx="5.5" cy="17.5" r="3.5" />
                  <circle cx="15" cy="5" r="1" />
                  <path d="M12 17.5V14l-3-3 4-3 2 3h2" />
                </svg>
                {isLoading ? "carregando..." : "pedidos online"}
              </span>
            )}

            {storeStatus && (
              <div className="mt-1 flex flex-col items-center gap-1">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-widest ${
                    storeStatus.isOpen
                      ? "border-green-200 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-400"
                      : "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      storeStatus.isOpen ? "bg-green-500" : "bg-red-500"
                    }`}
                  />
                  {storeStatus.isOpen ? "Aberto agora" : "Fechado no momento"}
                </span>
                {!storeStatus.isOpen && nextOpeningLabel && (
                  <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                    Abre {nextOpeningLabel}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Barra de Navegação por Categorias (Sticky Top ao Rolar) */}
      {categories.length > 0 && (
      <nav
        aria-label="Categorias do cardápio"
        className="sticky top-0 z-30 border-b border-gray-200/70 bg-gray-50/95 px-4 py-3 backdrop-blur-sm dark:border-gray-800 dark:bg-gray-950/95 sm:px-6"
      >
        <div className="mx-auto max-w-2xl">
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-haspopup="listbox"
              className="inline-flex w-full items-center justify-between gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 ring-1 ring-gray-200 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:hover:bg-gray-700 dark:focus:ring-yellow-400"
            >
              <span className="truncate">
                Navegar por Categorias
                {activeCategory && (
                  <span className="font-normal text-gray-400">
                    {" — "}{activeCategory}
                  </span>
                )}
              </span>
              <svg
                aria-hidden="true"
                className={`h-4 w-4 shrink-0 transition-transform ${
                  menuOpen ? "rotate-180" : ""
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m19.5 8.25-7.5 7.5-7.5-7.5"
                />
              </svg>
            </button>

            {menuOpen && (
              <ul
                role="listbox"
                aria-label="Escolha uma categoria"
                className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
              >
                {categories.map((category) => {
                  const isCurrent = activeCategory === category;
                  const count =
                    productsByCategory.get(category)?.length ?? 0;
                  return (
                    <li key={category} role="option" aria-selected={isCurrent}>
                      <button
                        type="button"
                        onClick={() => scrollToCategory(category)}
                        className={`flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm transition focus:outline-none focus:bg-gray-100 dark:focus:bg-gray-700 ${
                          isCurrent
                            ? "bg-gray-100 font-bold text-gray-900 dark:bg-gray-700 dark:text-white"
                            : "font-medium text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/60"
                        }`}
                      >
                        <span className="truncate">{category}</span>
                        <span className="shrink-0 text-xs font-semibold tabular-nums text-gray-400">
                          {count} {count === 1 ? "item" : "itens"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </nav>
      )}

      {/* Conteúdo Principal: Lista de Produtos em Grid (2 por linha) */}
      <main
        className={`customer-view-enter flex-1 px-4 pt-4 sm:px-6 ${contentBottomPadding}`}
      >
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Aviso de loja fechada — o checkout e a API também bloqueiam. */}
          {!isLoading && storeStatus && !storeStatus.isOpen && (
            <div
              role="status"
              className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/40"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-100 text-sm font-bold text-red-600 dark:bg-red-500/15 dark:text-red-400"
                >
                  !
                </span>
                <div>
                  <p className="text-sm font-bold text-red-700 dark:text-red-300">
                    Estabelecimento fechado
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-red-600 dark:text-red-400">
                    O estabelecimento encontra-se fechado no momento e não está
                    recebendo pedidos.
                    {nextOpeningLabel ? ` Abrimos ${nextOpeningLabel}.` : ""}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Carregando o cardápio */}
          {isLoading && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col items-center justify-center gap-3 py-16 text-gray-500 dark:text-gray-400"
            >
              <svg
                aria-hidden="true"
                className="h-8 w-8 animate-spin text-gray-900 dark:text-yellow-400"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth={4}
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
              <p className="text-sm font-medium">Carregando cardápio...</p>
            </div>
          )}

          {/* Erro ao carregar */}
          {!isLoading && loadError && (
            <div
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900/50 dark:bg-red-950/40"
            >
              <h2 className="text-lg font-bold text-red-700 dark:text-red-300">
                Não foi possível carregar o cardápio
              </h2>
              <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                {loadError}
              </p>
            </div>
          )}

          {/* Loja sem itens cadastrados */}
          {!isLoading && !loadError && categories.length === 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center dark:border-gray-800 dark:bg-gray-900">
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                Cardápio em construção
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Nenhum item disponível no momento. Volte em breve!
              </p>
            </div>
          )}

          {categories.map((category) => (
            <section
              key={category}
              id={slugify(category)}
              aria-labelledby={`${slugify(category)}-title`}
              className="scroll-mt-20 pt-2"
            >
              <h2
                id={`${slugify(category)}-title`}
                className="mb-3 text-xl font-bold text-gray-900 dark:text-white"
              >
                {category}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                {(productsByCategory.get(category) ?? []).map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    quantity={quantityOf(product.id)}
                    onRemove={removeItem}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>

      {/* Modal de Personalização */}
      <ProductModal
        key={modalKey}
        product={selectedProduct}
        onClose={() => setSelectedProduct(null)}
      />

      {/* Resumo do Carrinho Fixo.
          Regra de navegação: este CTA existe SOMENTE enquanto há itens no
          carrinho e leva SEMPRE ao checkout (`/[slug]/checkout`). O
          acompanhamento do pedido anterior fica na barra inferior
          ("Acompanhar pedido" → `/pedido/[id]`) — as duas telas nunca se
          misturam. */}
      {/* Sacola lateral: exibe itens, calcula o frete (fixo ou por CEP/km) e
          só então libera o avanço para o checkout. */}
      <CartDrawer
        open={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        slug={slug}
        establishment={menu?.establishment ?? null}
        storeClosed={storeClosed}
        nextOpeningLabel={nextOpeningLabel}
      />

      {/* Barra inferior fixa da vitrine: resumo da sacola (quando há itens)
          empilhado acima da navegação principal. O container único garante que
          a navegação nunca cubra o CTA da sacola — e o padding do `<main>`
          (`contentBottomPadding`) reserva essa altura no fim da listagem. */}
      <div className={`${BOTTOM_NAV_FIXED_CONTAINER} flex flex-col`}>
        {itemCount > 0 && (
          <CartSummary
            onOpen={() => setIsCartOpen(true)}
            establishmentId={menu?.establishment.id ?? null}
            storeClosed={storeClosed}
            nextOpeningLabel={nextOpeningLabel}
          />
        )}
        <StorefrontBottomNav
          active="menu"
          onShowMenu={showMenu}
          trackHref={trackHref}
          ordersHref={ordersHref}
          isTrackLoading={isTrackLoading}
        />
      </div>
    </div>
  );
}