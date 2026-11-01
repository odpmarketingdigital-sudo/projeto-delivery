import Link from "next/link";
import type { ReactNode } from "react";
import { LandingBrand } from "../landing/LandingBrand";
import { Icon } from "../landing/LandingIcons";
import {
  COMPANY_NAME,
  LEGAL_LAST_UPDATED_DISPLAY,
  LEGAL_LAST_UPDATED_ISO,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  SUPPORT_PHONE_DISPLAY,
  SUPPORT_WHATSAPP_URL,
} from "./legalContent";

/** Item do sumário exibido logo abaixo do título da página. */
export type LegalNavItem = { id: string; title: string };

/**
 * Casca compartilhada das páginas legais (`/privacidade` e `/termos`).
 *
 * Mantém o mesmo tema escuro da Landing Page: cabeçalho com a marca e o
 * atalho de volta, container centralizado (`max-w-4xl`), sumário com âncoras,
 * conteúdo e rodapé com links cruzados e canais de suporte.
 */
export function LegalPageShell({
  title,
  eyebrow,
  summary,
  sections,
  children,
}: {
  title: string;
  eyebrow: string;
  /** Parágrafo de abertura exibido abaixo da data de atualização. */
  summary: string;
  sections: LegalNavItem[];
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[#07090c] font-sans text-gray-100 antialiased selection:bg-amber-400 selection:text-gray-950">
      <a
        href="#conteudo"
        className="sr-only z-[60] rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-gray-950 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Pular para o conteúdo
      </a>

      <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-[#07090c]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <LandingBrand />

          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-3.5 py-2 text-sm font-semibold text-gray-200 transition hover:border-white/25 hover:bg-white/[0.07] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            <Icon name="arrowRight" className="h-4 w-4 rotate-180" />
            <span className="hidden sm:inline">Voltar para o início</span>
            <span className="sm:hidden">Início</span>
          </Link>
        </div>
      </header>

      <main id="conteudo" className="relative flex-1">
        {/* Brilho decorativo no topo, seguindo a identidade visual da landing. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(250,204,21,0.10),transparent_70%)]"
        />

        <div className="relative mx-auto max-w-4xl px-4 py-12">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-400">
            {eyebrow}
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 text-sm text-gray-400">
            Última atualização:{" "}
            <time dateTime={LEGAL_LAST_UPDATED_ISO}>
              {LEGAL_LAST_UPDATED_DISPLAY}
            </time>
          </p>

          <p className="mt-5 text-base leading-relaxed text-gray-400">
            {summary}
          </p>

          <nav
            aria-label={`Sumário de ${title}`}
            className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5"
          >
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-gray-300">
              Nesta página
            </p>
            <ol className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {sections.map((section, index) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="inline-flex gap-2 rounded px-1 py-1 text-sm text-gray-400 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  >
                    <span aria-hidden className="tabular-nums text-amber-400/80">
                      {index + 1}.
                    </span>
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="mt-10 space-y-10 border-t border-white/[0.08] pt-10">
            {children}
          </div>
        </div>
      </main>

      <footer className="border-t border-white/[0.08] bg-[#05070a]">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-8 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {PRODUCT_NAME}. Todos os direitos reservados. Desenvolvido e
            gerenciado por {COMPANY_NAME}.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              href="/privacidade"
              className="rounded transition hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              Política de Privacidade
            </Link>
            <Link
              href="/termos"
              className="rounded transition hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              Termos de Uso
            </Link>
            <a
              href={SUPPORT_WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded transition hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <Icon name="whatsapp" className="h-3.5 w-3.5 text-emerald-400" />
              {SUPPORT_PHONE_DISPLAY}
            </a>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="rounded transition hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
