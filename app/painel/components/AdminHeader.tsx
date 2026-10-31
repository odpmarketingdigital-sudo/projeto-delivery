"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { SidebarMenuButton } from "./PanelShell";

/**
 * Barra superior da área de conteúdo do painel.
 *
 * A navegação principal vive na sidebar escura (<PanelShell>); aqui ficam
 * apenas o atalho mobile do menu, a identificação do painel, o contexto
 * (papel/loja) e o botão "Ver Meu Cardápio".
 *
 * O slug da vitrine pública é consultado via RLS porque o componente só recebe
 * o `establishment_id` (o admin lê a própria loja; o super admin, qualquer
 * uma). Sem slug conhecido, o link cai em `/`, que resolve a primeira loja.
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

export function AdminHeader({
  establishmentId,
  isSuperAdmin,
  badge,
}: AdminHeaderProps) {
  const supabase = useMemo(() => createClient(), []);

  // Slug público da loja selecionada (URL da vitrine: `/${slug}`).
  // Guardamos o id junto do slug para DERIVAR o valor atual: quando
  // `establishmentId` muda (ou é null), o valor antigo é ignorado sem
  // precisar de um setState síncrono dentro do efeito.
  const [slugState, setSlugState] = useState<{
    id: string;
    slug: string | null;
  } | null>(null);

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

  /** Selo de contexto: papel da plataforma ou loja selecionada. */
  const scopeLabel = isSuperAdmin
    ? "Super Admin"
    : establishmentId
      ? `Loja: ${establishmentId.slice(0, 8)}…`
      : "Todas lojas";

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarMenuButton />

          <Link
            href={isSuperAdmin ? "/painel/admin" : "/painel"}
            aria-label={
              isSuperAdmin
                ? "Ipepper — ir para a Dashboard SaaS"
                : "Ipepper — ir para Pedidos"
            }
            className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 lg:hidden"
          >
            <Image
              src="/logotipo.svg"
              alt="Ipepper"
              width={323}
              height={150}
              preload
              unoptimized
              className="h-7 w-auto"
            />
          </Link>

          <div className="hidden min-w-0 lg:block">
            <p className="truncate text-sm font-bold text-slate-900">
              {isSuperAdmin ? "Painel SaaS" : "Painel do Restaurante"}
            </p>
            <p className="truncate text-xs font-medium text-slate-500">
              {isSuperAdmin
                ? "Gestão de assinantes, planos e receita"
                : "Gestão de pedidos, produtos e configurações"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {badge}

          <span className="hidden items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 sm:inline-flex">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${
                isSuperAdmin ? "bg-red-500" : "bg-amber-400"
              }`}
            />
            {scopeLabel}
          </span>

          {establishmentId && (
            <a
              href={publicHref}
              target="_blank"
              rel="noopener noreferrer"
              title="Abre o cardápio público em uma nova aba"
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-400 px-3.5 py-2 text-sm font-bold text-slate-950 transition hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
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
    </header>
  );
}
