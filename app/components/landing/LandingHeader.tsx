"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LandingBrand } from "./LandingBrand";
import { Icon } from "./LandingIcons";

const NAV_LINKS = [
  { href: "#inicio", label: "Início" },
  { href: "#como-funciona", label: "Como Funciona" },
  { href: "#recursos", label: "Recursos" },
  { href: "#sistema", label: "Sistema" },
  { href: "#planos", label: "Planos" },
  { href: "#beneficios", label: "Benefícios" },
  { href: "#depoimentos", label: "Depoimentos" },
];

/**
 * Cabeçalho fixo da Landing Page.
 *
 * Client Component por causa do menu mobile. Os links de navegação usam
 * âncoras (`#secao`) — o scroll suave é definido em `globals.css` e respeita
 * `prefers-reduced-motion`.
 */
export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  // Fecha o menu com Esc (acessibilidade para navegação por teclado).
  useEffect(() => {
    if (!menuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-[#07090c]/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <LandingBrand />

        <nav
          aria-label="Navegação principal"
          className="hidden items-center gap-4 lg:flex xl:gap-6"
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-md text-sm font-medium text-gray-400 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2.5 md:flex">
          <Link
            href="/painel"
            className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/[0.03] px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:border-white/25 hover:bg-white/[0.07] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            Acessar Painel
          </Link>
          <Link
            href="/demo"
            className="group inline-flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-lg shadow-amber-500/20 transition hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            <span className="hidden xl:inline">Ver Cardápio Demonstração</span>
            <span className="xl:hidden">Ver Cardápio</span>
            <Icon
              name="arrowRight"
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        </div>

        <button
          type="button"
          aria-label={menuOpen ? "Fechar menu" : "Abrir menu"}
          aria-expanded={menuOpen}
          aria-controls="landing-mobile-menu"
          onClick={() => setMenuOpen((open) => !open)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/[0.03] text-gray-200 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 lg:hidden"
        >
          <Icon name={menuOpen ? "close" : "menu"} className="h-5 w-5" />
        </button>
      </div>

      {menuOpen && (
        <div
          id="landing-mobile-menu"
          className="border-t border-white/[0.08] bg-[#07090c]/98 px-4 pb-5 pt-3 shadow-2xl shadow-black/40 backdrop-blur-xl lg:hidden"
        >
          <nav aria-label="Navegação mobile" className="flex flex-col">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={closeMenu}
                className="rounded-lg px-2 py-3 text-sm font-medium text-gray-300 transition hover:bg-white/[0.05] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="mt-3 grid gap-2 border-t border-white/[0.08] pt-4">
            <Link
              href="/painel"
              onClick={closeMenu}
              className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/[0.03] px-4 py-3 text-sm font-semibold text-gray-100 transition hover:bg-white/[0.07]"
            >
              Acessar Painel
            </Link>
            <Link
              href="/demo"
              onClick={closeMenu}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 text-sm font-bold text-gray-950 transition hover:bg-amber-300"
            >
              Ver Cardápio Demonstração
              <Icon name="arrowRight" className="h-4 w-4" />
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
