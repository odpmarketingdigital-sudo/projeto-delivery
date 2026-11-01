import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Bloco de conteúdo das páginas legais.
 *
 * Cada seção recebe um `id` estável para servir de âncora no sumário do topo.
 * O `scroll-mt-24` compensa o cabeçalho fixo para o título não ficar escondido
 * ao navegar por `#secao-n`.
 */
export function LegalSection({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="scroll-mt-24">
      <h2
        id={`${id}-titulo`}
        className="flex items-baseline gap-2.5 text-xl font-bold tracking-tight text-white sm:text-2xl"
      >
        <span aria-hidden className="tabular-nums text-amber-400">
          {number}.
        </span>
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-gray-400 sm:text-base">
        {children}
      </div>
    </section>
  );
}

/** Subtítulo (h3) dentro de uma seção, para detalhar incisos e alíneas. */
export function LegalSubheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="pt-1 text-base font-semibold text-gray-100 sm:text-lg">
      {children}
    </h3>
  );
}

/** Lista padronizada (marcadores em âmbar) usada nos documentos. */
export function LegalList({ children }: { children: ReactNode }) {
  return (
    <ul className="list-disc space-y-2 pl-5 marker:text-amber-400/80">
      {children}
    </ul>
  );
}

/** Link interno ou externo com o mesmo realce em ambos os documentos. */
export function LegalLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  const className =
    "rounded font-semibold text-amber-300 underline-offset-4 transition hover:text-amber-200 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950";

  // Rotas internas usam `next/link` (prefetch e navegação no cliente).
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <a
      href={href}
      className={className}
      {...(external
        ? { target: "_blank", rel: "noopener noreferrer" }
        : undefined)}
    >
      {children}
    </a>
  );
}

/** Destaque para informações de contato, prazos e avisos importantes. */
export function LegalCallout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-5 text-sm leading-relaxed text-gray-300">
      {children}
    </div>
  );
}
