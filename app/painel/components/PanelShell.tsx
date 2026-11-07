"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AuthUser } from "@/context/AuthContext";
import { LogoutButton } from "@/app/components/LogoutButton";

/**
 * Casca visual do painel: menu lateral esquerdo escuro (#0d0f12) + área de
 * conteúdo clara.
 *
 * A sidebar é fixa no desktop (`lg:`), sticky e com altura de viewport, e vira
 * um drawer no mobile — aberto pelo botão hambúrguer do <AdminHeader>, que
 * consome o contexto abaixo. Assim o layout é renderizado uma única vez pelo
 * guard e permanece montado durante a navegação entre as telas do painel.
 *
 * No desktop a sidebar tem dois modos: expandida (`w-64`, ícones + rótulos) e
 * recolhida (`w-20`, somente ícones com tooltip). A preferência fica no
 * `localStorage` e sobrevive à navegação/recarregamento; no mobile o drawer é
 * sempre expandido.
 *
 * A navegação por papel é a mesma do <AdminHeader> anterior:
 *  - admin de loja → Pedidos, Dashboard, Clientes, Cupons, Produtos,
 *    Configurações e Assinatura;
 *  - super_admin → Dashboard SaaS, Assinantes, Cupons de Assinatura e Preço do
 *    Plano (o super admin não opera loja).
 */

/* -------------------------------------------------------------------------- */
/* Preferência de largura da sidebar (localStorage)                            */
/* -------------------------------------------------------------------------- */

/** Chave do `localStorage` com a preferência de sidebar recolhida. */
const SIDEBAR_COLLAPSED_KEY = "ipepper_painel_sidebar_collapsed";

/**
 * Cache em memória da preferência.
 *
 * `useSyncExternalStore` exige que `getSnapshot` devolva sempre o mesmo valor
 * enquanto nada muda, por isso o `localStorage` é lido uma única vez e o
 * resultado fica guardado aqui (ele só muda pelo toggle do próprio painel).
 */
let sidebarCollapsedCache: boolean | null = null;

const sidebarCollapsedListeners = new Set<() => void>();

/** Lê a preferência salva (no SSR ou sem acesso, assume expandida). */
function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    /* localStorage indisponível (modo privado/bloqueado). */
    return false;
  }
}

/** Snapshot do cliente (cacheado entre renderizações). */
function getSidebarCollapsedSnapshot(): boolean {
  if (sidebarCollapsedCache === null) {
    sidebarCollapsedCache = readSidebarCollapsed();
  }
  return sidebarCollapsedCache;
}

/**
 * Snapshot usado na hidratação: o HTML do servidor é sempre o da sidebar
 * expandida, então o primeiro render do cliente precisa dizer o mesmo antes de
 * assumir a preferência salva.
 */
function getSidebarCollapsedServerSnapshot(): boolean {
  return false;
}

function subscribeSidebarCollapsed(listener: () => void): () => void {
  sidebarCollapsedListeners.add(listener);
  return () => {
    sidebarCollapsedListeners.delete(listener);
  };
}

/** Recolhe/expande a sidebar e propaga para as instâncias montadas. */
function setSidebarCollapsed(collapsed: boolean): void {
  sidebarCollapsedCache = collapsed;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    /* localStorage indisponível (modo privado/bloqueado). */
  }
  sidebarCollapsedListeners.forEach((listener) => listener());
}

/** Inverte o modo atual — ação do botão de toggle. */
function toggleSidebarCollapsed(): void {
  setSidebarCollapsed(!getSidebarCollapsedSnapshot());
}

/** Página atual do painel (usada para destacar o item ativo). */
export type PanelPage =
  | "pedidos"
  | "dashboard"
  | "clientes"
  | "cupons"
  | "produtos"
  | "configuracoes"
  | "assinatura"
  | "admin"
  | "admin-assinantes"
  | "admin-cupons"
  | "admin-configuracoes";

/** Ícones desenhados em linha (sem dependência externa). */
type IconName =
  | "orders"
  | "dashboard"
  | "customers"
  | "coupons"
  | "products"
  | "settings"
  | "subscription";

interface NavItem {
  page: PanelPage;
  href: string;
  label: string;
  icon: IconName;
}

/** Menus operacionais de loja. */
const STORE_NAV_ITEMS: NavItem[] = [
  { page: "pedidos", href: "/painel", label: "Pedidos", icon: "orders" },
  {
    page: "dashboard",
    href: "/painel/dashboard",
    label: "Dashboard",
    icon: "dashboard",
  },
  {
    page: "clientes",
    href: "/painel/clientes",
    label: "Clientes",
    icon: "customers",
  },
  { page: "cupons", href: "/painel/cupons", label: "Cupons", icon: "coupons" },
  {
    page: "produtos",
    href: "/painel/produtos",
    label: "Produtos",
    icon: "products",
  },
  {
    page: "configuracoes",
    href: "/painel/configuracoes",
    label: "Configurações",
    icon: "settings",
  },
  {
    page: "assinatura",
    href: "/painel/assinatura",
    label: "Assinatura",
    icon: "subscription",
  },
];

/** Menus de gestão do SaaS (super admin). */
const SAAS_NAV_ITEMS: NavItem[] = [
  {
    page: "admin",
    href: "/painel/admin",
    label: "Dashboard SaaS",
    icon: "dashboard",
  },
  {
    page: "admin-assinantes",
    href: "/painel/admin/assinantes",
    label: "Assinantes",
    icon: "customers",
  },
  {
    page: "admin-cupons",
    href: "/painel/admin/cupons",
    label: "Cupons de Assinatura",
    icon: "coupons",
  },
  {
    page: "admin-configuracoes",
    href: "/painel/admin/configuracoes",
    label: "Preço do Plano",
    icon: "subscription",
  },
];

/** Rota atual → página destacada na sidebar. */
export function resolvePanelPage(pathname: string): PanelPage | null {
  if (pathname.startsWith("/painel/dashboard")) return "dashboard";
  if (pathname.startsWith("/painel/clientes")) return "clientes";
  if (pathname.startsWith("/painel/cupons")) return "cupons";
  if (pathname.startsWith("/painel/configuracoes")) return "configuracoes";
  if (pathname.startsWith("/painel/assinatura")) return "assinatura";
  if (pathname.startsWith("/painel/produtos")) return "produtos";
  if (pathname.startsWith("/painel/admin/assinantes")) return "admin-assinantes";
  if (pathname.startsWith("/painel/admin/cupons")) return "admin-cupons";
  if (pathname.startsWith("/painel/admin/configuracoes"))
    return "admin-configuracoes";
  if (pathname.startsWith("/painel/admin")) return "admin";
  if (pathname.startsWith("/painel")) return "pedidos";
  return null;
}

/* -------------------------------------------------------------------------- */
/* Contexto: o header de cada página abre o drawer no mobile                   */
/* -------------------------------------------------------------------------- */

interface PanelShellContextValue {
  isSidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
}

const PanelShellContext = createContext<PanelShellContextValue | null>(null);

/** Acesso ao drawer da sidebar (usado pelo <AdminHeader>). */
export function usePanelShell(): PanelShellContextValue {
  return (
    useContext(PanelShellContext) ?? {
      isSidebarOpen: false,
      openSidebar: () => {},
      closeSidebar: () => {},
    }
  );
}

function NavIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    orders: (
      <>
        <path d="M8 3h8a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2V5a2 2 0 0 1 2-2Z" />
        <path d="M9 8h6M9 12h6" />
      </>
    ),
    dashboard: (
      <>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </>
    ),
    customers: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
        <path d="M16 5.5a3 3 0 0 1 0 6M17.5 14.5A5 5 0 0 1 21 20" />
      </>
    ),
    coupons: (
      <>
        <path d="M3 9V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6Z" />
        <path d="M13 5v14" />
      </>
    ),
    products: (
      <>
        <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
        <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 20.96 10H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    subscription: (
      <>
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="M2.5 10h19" />
        <path d="M7 15h4" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className="h-[18px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      {paths[name]}
    </svg>
  );
}

/** Chevron do botão que recolhe/expande a sidebar (aponta para o lado livre). */
function CollapseChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
    </svg>
  );
}

/** Tooltip do modo recolhido: item apontado e posição (px) na viewport. */
interface SidebarTooltipState {
  page: PanelPage;
  label: string;
  top: number;
  left: number;
}

function SidebarBody({
  currentUser,
  isSuperAdmin,
  onNavigate,
  onClose,
  isCollapsed = false,
  onToggleCollapsed,
}: {
  currentUser: AuthUser;
  isSuperAdmin: boolean;
  onNavigate?: () => void;
  onClose?: () => void;
  /** Modo compacto do desktop: somente ícones, com tooltip em cada item. */
  isCollapsed?: boolean;
  /** Alterna expandido/recolhido (ausente no drawer mobile). */
  onToggleCollapsed?: () => void;
}) {
  const pathname = usePathname();
  const currentPage = resolvePanelPage(pathname);
  const navItems = isSuperAdmin ? SAAS_NAV_ITEMS : STORE_NAV_ITEMS;

  const initials = (currentUser.name ?? "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "IP";

  /**
   * Tooltip do modo recolhido: guarda o item apontado e a posição medida no
   * hover/focus. Sem ele o rótulo desaparece junto com a largura da sidebar e
   * o ícone fica sem nome visível.
   */
  const [tooltip, setTooltip] = useState<SidebarTooltipState | null>(null);

  const showTooltip = useCallback((item: NavItem, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setTooltip({
      page: item.page,
      label: item.label,
      top: rect.top + rect.height / 2,
      left: rect.right + 12,
    });
  }, []);

  const hideTooltip = useCallback(() => setTooltip(null), []);

  /** Navegar fecha o tooltip (o clique pode não disparar `mouseleave`). */
  const handleNavigate = useCallback(() => {
    setTooltip(null);
    onNavigate?.();
  }, [onNavigate]);

  /**
   * Destino do item — sempre a rota "limpa", sem `?establishment_id=`.
   *
   * A loja ativa é resolvida pelo contexto da sessão (o `SubscriptionProvider`
   * lê `establishments` pela RLS `establishments_select_own`) e, no servidor,
   * pela própria rota (`/painel/assinatura`). Carregar o id na URL em cada
   * clique só inflava a query string e, com os cookies fatiados da sessão,
   * empurrava a requisição para o limite de headers (HTTP 431).
   *
   * O parâmetro continua aceito como deep-link pontual do super admin em telas
   * que precisam escolher a loja — nunca gerado por este menu.
   */

  return (
    <>
      <div
        className={`flex items-center gap-2 ${
          isCollapsed ? "flex-col px-2 py-4" : "justify-between px-5 py-5"
        }`}
      >
        <Link
          href={isSuperAdmin ? "/painel/admin" : "/painel"}
          onClick={handleNavigate}
          aria-label={
            isSuperAdmin
              ? "Ipepper — ir para a Dashboard SaaS"
              : "Ipepper — ir para Pedidos"
          }
          className="flex min-w-0 items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          {isCollapsed ? (
            /* Recolhida: só a pimentinha do favicon, sem o wordmark. */
            <Image
              src="/favicon.png"
              alt="Ipepper"
              width={512}
              height={512}
              preload
              unoptimized
              className="h-9 w-9"
            />
          ) : (
            <Image
              src="/logotipo.svg"
              alt="Ipepper"
              width={323}
              height={150}
              preload
              unoptimized
              className="h-8 w-auto"
            />
          )}
        </Link>

        {onToggleCollapsed && (
          <button
            type="button"
            onClick={() => {
              setTooltip(null);
              onToggleCollapsed();
            }}
            aria-label={
              isCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"
            }
            aria-expanded={!isCollapsed}
            aria-controls="painel-sidebar"
            title={isCollapsed ? "Expandir menu" : "Recolher menu"}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <CollapseChevron collapsed={isCollapsed} />
          </button>
        )}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            autoFocus
            aria-label="Fechar menu"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
          >
            <svg
              aria-hidden="true"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              viewBox="0 0 24 24"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>

      <nav
        aria-label="Navegação do painel"
        onScroll={isCollapsed ? hideTooltip : undefined}
        className={`flex-1 overflow-y-auto overflow-x-hidden pb-4 ${
          isCollapsed ? "px-2" : "px-3"
        }`}
      >
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive = currentPage === item.page;
            return (
              <li key={item.page}>
                <Link
                  href={item.href}
                  onClick={handleNavigate}
                  aria-current={isActive ? "page" : undefined}
                  aria-describedby={
                    isCollapsed && tooltip?.page === item.page
                      ? "painel-sidebar-tooltip"
                      : undefined
                  }
                  onMouseEnter={
                    isCollapsed
                      ? (event) => showTooltip(item, event.currentTarget)
                      : undefined
                  }
                  onMouseLeave={isCollapsed ? hideTooltip : undefined}
                  onFocus={
                    isCollapsed
                      ? (event) => showTooltip(item, event.currentTarget)
                      : undefined
                  }
                  onBlur={isCollapsed ? hideTooltip : undefined}
                  className={`relative flex items-center rounded-xl text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 ${
                    isCollapsed ? "justify-center py-2.5" : "gap-3 px-3 py-2.5"
                  } ${
                    isActive
                      ? "bg-white/10 text-white"
                      : "text-slate-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-amber-400 transition-opacity ${
                      isActive ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <NavIcon name={item.icon} />
                  {/*
                    O rótulo continua no DOM (inclusive recolhido) para manter
                    o nome acessível do link; no modo compacto ele sai de cena
                    via `sr-only` e o texto visível vira o tooltip.
                  */}
                  <span className={isCollapsed ? "sr-only" : "truncate"}>
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div
        className={`border-t border-white/10 ${isCollapsed ? "p-2" : "p-3"}`}
      >
        {isCollapsed ? (
          /* Recolhida: avatar centralizado + sair apenas com o ícone. */
          <div className="flex flex-col items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-xs font-bold text-amber-300"
            >
              {initials}
            </span>
            <span className="sr-only">
              {`${currentUser.name || "Usuário"} — ${
                isSuperAdmin
                  ? "Super Admin"
                  : currentUser.establishment || "Administrador"
              }`}
            </span>
            <LogoutButton variant="dark" compact />
          </div>
        ) : (
          <div className="rounded-xl bg-white/[0.04] p-3">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-xs font-bold text-amber-300"
              >
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {currentUser.name || "Usuário"}
                </p>
                <p className="truncate text-[11px] font-medium text-slate-400">
                  {isSuperAdmin
                    ? "Super Admin"
                    : currentUser.establishment || "Administrador"}
                </p>
              </div>
            </div>
            <div className="mt-3">
              <LogoutButton variant="dark" />
            </div>
          </div>
        )}
      </div>

      {/*
        Tooltip do modo recolhido: `fixed` para não ser cortado pelo
        `overflow-y-auto` do menu (posicionado a partir do rect do link).
      */}
      {isCollapsed && tooltip && (
        <span
          id="painel-sidebar-tooltip"
          role="tooltip"
          style={{ top: tooltip.top, left: tooltip.left }}
          className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-[#0d0f12] px-2.5 py-1.5 text-xs font-semibold text-white shadow-xl"
        >
          {tooltip.label}
        </span>
      )}
    </>
  );
}

/**
 * Casca do painel autenticado: sidebar fixa (desktop) / drawer (mobile) e a
 * área de conteúdo clara à direita.
 */
export function PanelShell({
  currentUser,
  isSuperAdmin,
  children,
}: {
  currentUser: AuthUser;
  isSuperAdmin: boolean;
  children: ReactNode;
}) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const openSidebar = useCallback(() => setIsSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);

  // Desktop: largura da sidebar (expandida/recolhida), persistida no navegador.
  const isSidebarCollapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    getSidebarCollapsedServerSnapshot
  );

  // Drawer aberto: fecha com Esc e trava a rolagem do documento atrás dele.
  useEffect(() => {
    if (!isSidebarOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsSidebarOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSidebarOpen]);

  const contextValue = useMemo(
    () => ({ isSidebarOpen, openSidebar, closeSidebar }),
    [isSidebarOpen, openSidebar, closeSidebar]
  );

  return (
    <PanelShellContext.Provider value={contextValue}>
      <div className="flex min-h-screen bg-slate-50 text-slate-900">
        <aside
          id="painel-sidebar"
          aria-label="Menu do painel"
          className={`sticky top-0 hidden h-screen shrink-0 flex-col overflow-x-hidden bg-[#0d0f12] transition-all duration-300 ease-in-out lg:flex ${
            isSidebarCollapsed ? "w-20" : "w-64"
          }`}
        >
          <SidebarBody
            currentUser={currentUser}
            isSuperAdmin={isSuperAdmin}
            isCollapsed={isSidebarCollapsed}
            onToggleCollapsed={toggleSidebarCollapsed}
          />
        </aside>

        {isSidebarOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="Fechar menu ao clicar fora"
              onClick={closeSidebar}
              className="absolute inset-0 h-full w-full cursor-default bg-slate-950/60 backdrop-blur-sm"
            />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label="Menu do painel"
              className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-[#0d0f12] shadow-2xl"
            >
              <SidebarBody
                currentUser={currentUser}
                isSuperAdmin={isSuperAdmin}
                onNavigate={closeSidebar}
                onClose={closeSidebar}
              />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </PanelShellContext.Provider>
  );
}

/**
 * Botão hambúrguer exibido no <AdminHeader> (somente mobile), que abre o
 * drawer da sidebar.
 */
export function SidebarMenuButton() {
  const { openSidebar } = usePanelShell();
  return (
    <button
      type="button"
      onClick={openSidebar}
      aria-label="Abrir menu do painel"
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 lg:hidden"
    >
      <svg
        aria-hidden="true"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        viewBox="0 0 24 24"
      >
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
}
