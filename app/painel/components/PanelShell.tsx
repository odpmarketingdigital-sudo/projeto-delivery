"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
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
 * A navegação por papel é a mesma do <AdminHeader> anterior:
 *  - admin de loja → Pedidos, Dashboard, Clientes, Cupons, Produtos,
 *    Configurações e Assinatura;
 *  - super_admin → Dashboard SaaS, Assinantes, Cupons de Assinatura e Preço do
 *    Plano (o super admin não opera loja).
 */

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

function SidebarBody({
  currentUser,
  isSuperAdmin,
  establishmentId,
  onNavigate,
  onClose,
}: {
  currentUser: AuthUser;
  isSuperAdmin: boolean;
  establishmentId?: string | null;
  onNavigate?: () => void;
  onClose?: () => void;
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

  /** Preserva a loja selecionada ao navegar (super admin opera qualquer loja). */
  const navHref = (item: NavItem): string =>
    !isSuperAdmin && establishmentId
      ? `${item.href}?establishment_id=${encodeURIComponent(establishmentId)}`
      : item.href;

  return (
    <>
      <div className="flex items-center justify-between gap-2 px-5 py-5">
        <Link
          href={isSuperAdmin ? "/painel/admin" : "/painel"}
          onClick={onNavigate}
          aria-label={
            isSuperAdmin
              ? "Ipepper — ir para a Dashboard SaaS"
              : "Ipepper — ir para Pedidos"
          }
          className="flex min-w-0 items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <Image
            src="/logotipo.svg"
            alt="Ipepper"
            width={323}
            height={150}
            preload
            unoptimized
            className="h-8 w-auto"
          />
        </Link>
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

      <p className="-mt-3 px-5 pb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {isSuperAdmin ? "Gestão do SaaS" : "Painel do restaurante"}
      </p>

      <nav aria-label="Navegação do painel" className="flex-1 overflow-y-auto px-3 pb-4">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive = currentPage === item.page;
            return (
              <li key={item.page}>
                <Link
                  href={navHref(item)}
                  onClick={onNavigate}
                  aria-current={isActive ? "page" : undefined}
                  className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 ${
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
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/10 p-3">
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
      </div>
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
  establishmentId,
  children,
}: {
  currentUser: AuthUser;
  isSuperAdmin: boolean;
  establishmentId?: string | null;
  children: ReactNode;
}) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const openSidebar = useCallback(() => setIsSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);

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
          aria-label="Menu do painel"
          className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-[#0d0f12] lg:flex"
        >
          <SidebarBody
            currentUser={currentUser}
            isSuperAdmin={isSuperAdmin}
            establishmentId={establishmentId}
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
                establishmentId={establishmentId}
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
