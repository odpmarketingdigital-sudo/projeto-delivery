import type { ReactNode } from "react";

/**
 * Ícones da Landing Page.
 *
 * O projeto não usa biblioteca externa de ícones; assim como no painel,
 * mantemos SVGs inline para não adicionar dependências. Todos herdam a cor via
 * `currentColor` e são decorativos (`aria-hidden`) — o texto ao redor descreve
 * a ação.
 */

export type IconName =
  | "arrowRight"
  | "bolt"
  | "chart"
  | "check"
  | "clipboard"
  | "clock"
  | "close"
  | "facebook"
  | "instagram"
  | "link"
  | "menu"
  | "play"
  | "shield"
  | "smartphone"
  | "sparkles"
  | "star"
  | "store"
  | "tag"
  | "users"
  | "whatsapp"
  | "x";

const paths: Record<IconName, ReactNode> = {
  arrowRight: (
    <>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  bolt: <path d="M13 2 4.5 14H10l-1 8 8.5-12H12l1-8Z" />,
  chart: (
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </>
  ),
  check: <path d="m20 6-11 11-5-5" />,
  clipboard: (
    <>
      <rect width="14" height="17" x="5" y="4" rx="2" />
      <path d="M9 4.5V3h6v1.5" />
      <path d="m9 13 2 2 4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  facebook: (
    <path d="M14 8h3V4h-3a5 5 0 0 0-5 5v3H6v4h3v6h4v-6h3l1-4h-4V9a1 1 0 0 1 1-1Z" />
  ),
  instagram: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4V8Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  smartphone: (
    <>
      <rect width="12" height="19" x="6" y="2.5" rx="2.5" />
      <path d="M10 18.5h4" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Z" />
      <path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" />
    </>
  ),
  star: (
    <path
      d="m12 2.7 2.9 5.8 6.4.9-4.6 4.5 1.1 6.4-5.8-3-5.8 3 1.1-6.4-4.6-4.5 6.4-.9L12 2.7Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  store: (
    <>
      <path d="M3 9.5 5 4h14l2 5.5" />
      <path d="M4 9.5V20h16V9.5" />
      <path d="M9 20v-6h6v6" />
      <path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
    </>
  ),
  tag: (
    <>
      <path d="M20.6 13.4 12 22l-9-9V4h9l8.6 8.6a1.4 1.4 0 0 1 0 1.8Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
      <path d="M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.5L3.5 20.5l1.4-4.3A8.5 8.5 0 1 1 20.5 11.6Z" />
      <path d="M8.7 8.2c.2-.4.4-.4.7-.4h.4c.2 0 .4 0 .5.3l.7 1.6c.1.2 0 .4-.1.6l-.5.6c-.1.2-.2.4 0 .7.5.9 1.2 1.6 2.1 2 .3.1.5 0 .7-.1l.6-.7c.2-.2.3-.2.6-.1l1.5.7c.3.1.4.3.4.5v.5c0 .3-.1.6-.4.8-.4.3-.9.4-1.4.3-2.8-.6-5-2.8-5.6-5.6-.1-.5 0-1 .2-1.4Z" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
};

export function Icon({
  name,
  className = "h-5 w-5",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}

/**
 * Marca do Ipepper: uma pimenta/chama estilizada em um quadrado com gradiente.
 * O tamanho e o arredondamento são definidos pelo consumidor via `className`.
 */
export function BrandMark({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-gray-950 shadow-lg shadow-amber-500/25 ${className}`}
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        className="h-[62%] w-[62%]"
        aria-hidden="true"
      >
        <path
          d="M16.2 27c5.4 0 9.3-3.6 9.3-8.4 0-4.6-3.7-7.4-8.4-9.3.8 3.4-.8 4.6-2.9 5.7.7-3.7-1.3-6.3-4-8.3.1 4.6-4.5 6.6-4.5 11.9C5.7 23.4 10.4 27 16.2 27Z"
          fill="currentColor"
        />
        <path
          d="M19.1 7.4c1.6-1.9 3.7-2.6 5.9-2.1-.5 2.2-1.9 3.7-4 4.3"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
