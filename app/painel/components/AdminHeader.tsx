"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Componente de cabeçalho/navegação reutilizável para o painel administrativo.
 *
 * A navegação depende do papel do usuário:
 *
 *  - admin de loja → Pedidos (`/painel`), Dashboard (`/painel/dashboard`),
 *    Clientes (`/painel/clientes`), Cupons (`/painel/cupons`),
 *    Produtos (`/painel/produtos`), Configurações (`/painel/configuracoes`)
 *    e Assinatura (`/painel/assinatura`);
 *  - super_admin → apenas a gestão do SaaS: Dashboard SaaS (`/painel/admin`),
 *    Assinantes (`/painel/admin/assinantes`), Cupons de Assinatura
 *    (`/painel/admin/cupons`) e Preço do Plano
 *    (`/painel/admin/configuracoes`). Os menus operacionais de loja ficam
 *    ocultos, porque o super admin administra a plataforma e não opera loja.
 *
 * Inclui também o atalho "Ver Meu Cardápio", que abre a vitrine pública do
 * estabelecimento selecionado (`/[slug]`) em nova aba. O slug é consultado
 * via RLS (o admin lê a própria loja; o super admin, qualquer uma) porque o
 * `AdminHeader` só recebe o `establishment_id`.
 *
 * Repassa o `establishment_id` na URL quando fornecido, preservando o
 * contexto do estabelecimento selecionado. O link ativo recebe o estilo
 * amarelo (botao destacado) e `aria-current="page"`.
 */
interface AdminHeaderProps {
  /** establishment_id atual (vindo do contexto do painel ou da URL). */
  establishmentId?: string | null;
  /** Indica se o usuário logado é super_admin. */
  isSuperAdmin: boolean;
  /**
   * Conteúdo opcional exibido no canto direito do cabeçalho (ex.: aviso de
   * "salvo com sucesso" na tela de Identidade Visual).
   */
  badge?: ReactNode;
}

/** Identificador da página atual, usado para destacar o link ativo. */
type PanelPage =
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

/** Item de navegação (label visível + rota base, sem query string). */
interface NavItem {
  page: PanelPage;
  href: string;
  label: string;
}

/** Menus operacionais de loja (papel `admin`). */
const STORE_NAV_ITEMS: NavItem[] = [
  { page: "pedidos", href: "/painel", label: "Pedidos" },
  { page: "dashboard", href: "/painel/dashboard", label: "Dashboard" },
  { page: "clientes", href: "/painel/clientes", label: "Clientes" },
  { page: "cupons", href: "/painel/cupons", label: "Cupons" },
  { page: "produtos", href: "/painel/produtos", label: "Produtos" },
  { page: "configuracoes", href: "/painel/configuracoes", label: "Configurações" },
  { page: "assinatura", href: "/painel/assinatura", label: "Assinatura" },
];

/** Menus de gestão do SaaS (papel `super_admin`). */
const SAAS_NAV_ITEMS: NavItem[] = [
  { page: "admin", href: "/painel/admin", label: "Dashboard SaaS" },
  {
    page: "admin-assinantes",
    href: "/painel/admin/assinantes",
    label: "Assinantes",
  },
  {
    page: "admin-cupons",
    href: "/painel/admin/cupons",
    label: "Cupons de Assinatura",
  },
  {
    page: "admin-configuracoes",
    href: "/painel/admin/configuracoes",
    label: "Preço do Plano",
  },
];

export function AdminHeader({ establishmentId, isSuperAdmin, badge }: AdminHeaderProps) {
  const pathname = usePathname();
  const supabase = useMemo(() => createClient(), []);

  // Slug público da loja selecionada (URL da vitrine: `/${slug}`).
  // Guardamos o id junto do slug para DERIVAR o valor atual: quando
  // `establishmentId` muda (ou é null), o valor antigo é ignorado sem
  // precisar de um setState síncrono dentro do efeito.
  const [slugState, setSlugState] = useState<{ id: string; slug: string | null } | null>(
    null
  );

  useEffect(() => {
    if (!establishmentId) return;
    let active = true;
    supabase
      .from("establishments")
      .select("slug")
      .eq("id", establishmentId)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return;
        const slug = data?.slug;
        setSlugState({
          id: establishmentId,
          slug: typeof slug === "string" && slug.trim() ? slug.trim() : null,
        });
      });
    return () => {
      active = false;
    };
  }, [establishmentId, supabase]);

  // null = ainda carregando / loja sem slug (base legada).
  const publicSlug =
    slugState && slugState.id === establishmentId ? slugState.slug : null;

  /**
   * URL pública da vitrine. Sem slug conhecido (base legada ou loja ainda
   * carregando), cai na rota raiz `/`, que resolve a primeira loja ativa.
   */
  const publicHref = publicSlug ? `/${publicSlug}` : "/";

  const currentPage: PanelPage | null = useMemo(() => {
    if (pathname.startsWith("/painel/dashboard")) return "dashboard";
    if (pathname.startsWith("/painel/clientes")) return "clientes";
    if (pathname.startsWith("/painel/cupons")) return "cupons";
    if (pathname.startsWith("/painel/configuracoes")) return "configuracoes";
    if (pathname.startsWith("/painel/assinatura")) return "assinatura";
    if (pathname.startsWith("/painel/produtos")) return "produtos";
    if (pathname.startsWith("/painel/admin/assinantes"))
      return "admin-assinantes";
    if (pathname.startsWith("/painel/admin/cupons")) return "admin-cupons";
    if (pathname.startsWith("/painel/admin/configuracoes"))
      return "admin-configuracoes";
    if (pathname.startsWith("/painel/admin")) return "admin";
    if (pathname.startsWith("/painel")) return "pedidos";
    return null;
  }, [pathname]);

  /**
   * Constroi a URL de destino, adicionando `establishment_id` quando houver
   * um estabelecimento selecionado — preserva o contexto do super admin ao
   * navegar entre as telas do painel.
   */
  const buildHref = (base: string): string => {
    return establishmentId ? `${base}?establishment_id=${establishmentId}` : base;
  };

  // Navegação por papel: super_admin vê só a gestão do SaaS; o admin de loja
  // vê os menus operacionais.
  const navItems = isSuperAdmin ? SAAS_NAV_ITEMS : STORE_NAV_ITEMS;

  /**
   * URL de um item de navegação. As rotas do SaaS não pertencem a uma loja,
   * então o `establishment_id` só é propagado na navegação do admin de loja.
   */
  const navHref = (item: NavItem): string =>
    isSuperAdmin ? item.href : buildHref(item.href);

  /** Selo de contexto: papel da plataforma ou loja selecionada. */
  const scopeLabel = isSuperAdmin
    ? "Super Admin"
    : establishmentId
      ? `Loja: ${establishmentId.slice(0, 8)}…`
      : "Todas lojas";

  const linkBaseClass =
    "shrink-0 whitespace-nowrap rounded-full border border-gray-700 px-4 py-1.5 text-sm font-semibold text-gray-300 transition hover:border-yellow-400/50 hover:text-white";

  const activeClass =
    "shrink-0 whitespace-nowrap rounded-full border border-yellow-400/40 bg-yellow-400/15 px-4 py-1.5 text-sm font-semibold text-yellow-300 transition";

  return (
    <header className="border-b border-gray-800 bg-gray-900/80 px-4 py-3 backdrop-blur-sm sm:px-6">
      <div className="mx-auto flex max-w-7xl items-center justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href={isSuperAdmin ? "/painel/admin" : buildHref("/painel")}
            aria-label={
              isSuperAdmin
                ? "Ipepper — ir para a Dashboard SaaS"
                : "Ipepper — ir para Pedidos"
            }
            className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
          >
            <Image
              src="/logotipo.svg"
              alt="Ipepper"
              width={323}
              height={150}
              preload
              unoptimized
              className="h-7 w-auto sm:h-9"
            />
          </Link>
          <div className="hidden min-w-0 sm:block">
            <p className="truncate font-bold text-white">
              {isSuperAdmin ? "Painel SaaS" : "Painel do Restaurante"}
            </p>
            <p className="hidden truncate text-xs font-medium text-gray-400 lg:block">
              {isSuperAdmin
                ? "Gestão de assinantes, planos e receita"
                : "Gestão de pedidos, produtos e configurações"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {badge}
          <span className="hidden rounded-full bg-yellow-400/15 px-3 py-1.5 text-sm font-semibold text-yellow-300 sm:inline">
            {scopeLabel}
          </span>
          {establishmentId && (
            <a
              href={publicHref}
              target="_blank"
              rel="noopener noreferrer"
              title="Abre o cardápio público em uma nova aba"
              className="inline-flex items-center gap-1.5 rounded-full bg-yellow-400 px-3.5 py-1.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200"
            >
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
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
              </svg>
              <span className="hidden sm:inline">Ver Meu Cardápio</span>
              <span className="sm:hidden">Cardápio</span>
            </a>
          )}
        </div>
      </div>

      <nav
        aria-label={
          isSuperAdmin ? "Administração do SaaS" : "Navegação do painel"
        }
        className="mx-auto mt-3 flex max-w-7xl gap-1.5 overflow-x-auto pb-0.5"
      >
        {navItems.map((item) => (
          <Link
            key={item.page}
            href={navHref(item)}
            className={`${linkBaseClass} ${
              currentPage === item.page ? activeClass : ""
            }`}
            aria-current={currentPage === item.page ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
