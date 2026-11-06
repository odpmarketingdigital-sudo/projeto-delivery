"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Barra de navegação inferior fixa do CLIENTE FINAL (mobile-first).
 *
 * Reúne, em três abas, todo o caminho pós-venda do cliente:
 *
 *  1. **Cardápio** — cardápio da loja (`/[slug]` ou `/demo`); quando já é a
 *     aba atual, apenas rola a página de volta ao topo;
 *  2. **Acompanhar pedido** — rastreio do pedido ativo (`/pedido/[id]`); sem
 *     pedido elegível, explica o motivo em uma faixa temporária;
 *  3. **Meus Pedidos** — histórico do cliente nesta loja (`/[slug]/pedidos`).
 *
 * O componente é o MESMO nas três telas — só muda a prop `active` —, então a
 * barra permanece fixa na base da tela ao navegar entre elas. A troca de aba é
 * uma navegação de cliente do Next: o `CartProvider` do layout raiz não
 * remonta e o carrinho continua intacto.
 *
 * O componente renderiza somente a barra: quem o usa é responsável por
 * posicioná-la (`BOTTOM_NAV_FIXED_CONTAINER`), empilhá-la junto da barra da
 * sacola (`CartSummary`) e reservar o espaço equivalente no fim do conteúdo
 * (`BOTTOM_NAV_CONTENT_PADDING`).
 */

/** Aba atual da barra inferior. */
export type CustomerBottomTab = "menu" | "track" | "orders";

/**
 * Classes do container fixo da barra. A vitrine acrescenta `flex flex-col`
 * para empilhar o resumo da sacola (`CartSummary`) acima da navegação.
 */
export const BOTTOM_NAV_FIXED_CONTAINER = "fixed inset-x-0 bottom-0 z-50";

/**
 * Altura reservada no fim do conteúdo das telas que exibem apenas a barra
 * (sem a barra da sacola), para que o último item nunca fique coberto.
 */
export const BOTTOM_NAV_CONTENT_PADDING = "pb-28";

/** Rola a página ao topo respeitando `prefers-reduced-motion`. */
export function scrollPageToTop(): void {
  if (typeof window === "undefined") return;
  const reduceMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

/** Aviso exibido ao tocar em "Acompanhar pedido" sem pedido em andamento. */
const NO_ACTIVE_ORDER_HINT =
  "Nenhum pedido em andamento. Assim que você enviar um pedido, o acompanhamento aparece aqui.";

/** Aviso exibido quando o histórico não tem slug público para link. */
const NO_HISTORY_HINT =
  "O histórico de pedidos fica disponível na página do cardápio do estabelecimento.";

/** Aviso exibido ao tocar em "Cardápio" sem slug público conhecido. */
const NO_MENU_HINT =
  "O cardápio fica disponível na página pública do estabelecimento.";

/** Classes comuns às três abas (mesma altura e área de toque confortável). */
const ITEM_BASE =
  "relative flex flex-col items-center justify-center gap-1 px-1 py-2.5 text-center text-[11px] font-semibold leading-tight transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:focus-visible:ring-yellow-400";

/** Aba atual. */
const ITEM_ACTIVE = "text-gray-900 dark:text-yellow-400";

/** Abas com destino disponível. */
const ITEM_IDLE =
  "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white";

/** Abas sem destino (explicam o motivo em vez de navegar). */
const ITEM_INACTIVE =
  "text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400";

interface StorefrontBottomNavProps {
  /** Aba atual: destacada, com `aria-current` e sem navegação. */
  active: CustomerBottomTab;
  /** Destino de "Cardápio"; `null` = já estamos no cardápio da loja. */
  menuHref?: string | null;
  /**
   * Chamado ao tocar em "Cardápio" quando ele já é a aba atual (a vitrine usa
   * para fechar o painel de categorias antes de rolar ao topo).
   */
  onShowMenu?: () => void;
  /** Link do pedido ativo (`/pedido/[id]`); `null` desabilita a aba. */
  trackHref: string | null;
  /** Link de "Meus Pedidos" (`/[slug]/pedidos`); `null` desabilita a aba. */
  ordersHref: string | null;
  /** `true` enquanto a consulta do pedido ativo ainda não resolveu. */
  isTrackLoading?: boolean;
}

/** Aba renderizada na barra. */
interface NavItem {
  tab: CustomerBottomTab;
  label: string;
  icon: ReactNode;
  /** Destino; `null` = sem destino (mostra a faixa de aviso). */
  href: string | null;
  /** Aviso exibido quando a aba não tem destino. */
  unavailableHint: string;
  /** Ponto âmbar de "pedido em andamento" sobre o ícone. */
  highlight?: boolean;
  /** `aria-busy` da aba sem destino (consulta em andamento). */
  busy?: boolean;
}

export function StorefrontBottomNav({
  active,
  menuHref = null,
  onShowMenu,
  trackHref,
  ordersHref,
  isTrackLoading = false,
}: StorefrontBottomNavProps) {
  // Faixa de aviso das abas sem destino (ex.: sem pedido ativo). O texto some
  // sozinho após alguns segundos — nenhum toque fica "mudo".
  const [hint, setHint] = useState<string | null>(null);
  const hintTimeoutRef = useRef<number | null>(null);

  // Cancela o timer pendente ao desmontar (navegação para outra aba).
  useEffect(() => {
    return () => {
      if (hintTimeoutRef.current !== null) {
        window.clearTimeout(hintTimeoutRef.current);
      }
    };
  }, []);

  /** Exibe a faixa de aviso e reinicia o timer de auto-ocultação. */
  const showHint = (message: string) => {
    if (hintTimeoutRef.current !== null) {
      window.clearTimeout(hintTimeoutRef.current);
    }
    setHint(message);
    hintTimeoutRef.current = window.setTimeout(() => {
      setHint(null);
      hintTimeoutRef.current = null;
    }, 4500);
  };

  const items: NavItem[] = [
    {
      tab: "menu",
      label: "Cardápio",
      icon: <UtensilsIcon />,
      href: menuHref,
      unavailableHint: NO_MENU_HINT,
    },
    {
      tab: "track",
      label: "Acompanhar pedido",
      icon: <TruckIcon />,
      href: trackHref,
      unavailableHint: isTrackLoading
        ? "Verificando se há pedido em andamento…"
        : NO_ACTIVE_ORDER_HINT,
      highlight: trackHref !== null,
      busy: isTrackLoading,
    },
    {
      tab: "orders",
      label: "Meus Pedidos",
      icon: <ReceiptIcon />,
      href: ordersHref,
      unavailableHint: NO_HISTORY_HINT,
    },
  ];

  /** Rola ao topo da tela atual (aba já ativa). */
  const handleActiveTab = (tab: CustomerBottomTab) => {
    // Na vitrine o `onShowMenu` já fecha as categorias e rola ao topo.
    if (tab === "menu" && onShowMenu) {
      onShowMenu();
      return;
    }
    scrollPageToTop();
  };

  return (
    <nav
      aria-label="Navegação do cardápio"
      className="border-t border-gray-200/70 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm dark:border-gray-800/80 dark:bg-gray-900/95"
    >
      {hint && (
        <p
          role="status"
          className="border-b border-gray-200/70 bg-gray-900 px-4 py-2 text-[11px] font-medium leading-snug text-white dark:border-gray-800 dark:bg-gray-800"
        >
          {hint}
        </p>
      )}

      <div className="mx-auto grid w-full max-w-2xl grid-cols-3">
        {items.map((item) => {
          const isActive = item.tab === active;
          const tone = isActive ? ITEM_ACTIVE : item.href ? ITEM_IDLE : ITEM_INACTIVE;
          const className = `${ITEM_BASE} ${tone}`;

          const content = (
            <>
              {/* Mesmo indicador de aba atual nas três telas. */}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 mx-auto h-0.5 w-10 rounded-full bg-amber-500"
                />
              )}
              <span className="relative inline-flex">
                {item.icon}
                {item.highlight && !isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-1.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-gray-900"
                  />
                )}
              </span>
              {item.label}
            </>
          );

          // Aba atual: já estamos nela — o toque rola a tela ao topo.
          if (isActive) {
            return (
              <button
                key={item.tab}
                type="button"
                aria-current="page"
                onClick={() => handleActiveTab(item.tab)}
                className={className}
              >
                {content}
              </button>
            );
          }

          // Aba com destino: navegação de cliente (prefetch mantém a troca
          // instantânea e preserva o carrinho do layout raiz).
          if (item.href) {
            return (
              <Link key={item.tab} href={item.href} className={className}>
                {content}
              </Link>
            );
          }

          // Aba sem destino: explica o motivo em vez de um toque sem resposta.
          return (
            <button
              key={item.tab}
              type="button"
              onClick={() => showHint(item.unavailableHint)}
              aria-busy={item.busy || undefined}
              className={className}
            >
              {content}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* --------------------------------------------------------------------------
 * Ícones (traçados do Lucide, inline para não adicionar dependência).
 * ----------------------------------------------------------------------- */

/** Aba "Cardápio": garfo e faca. */
function UtensilsIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
      <path d="M7 2v20" />
      <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
    </svg>
  );
}

/** Aba "Acompanhar pedido": caminhão de entrega. */
function TruckIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  );
}

/** Aba "Meus Pedidos": comprovante/recibo com linhas. */
function ReceiptIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M14 8H8" />
      <path d="M16 12H8" />
      <path d="M13 16H8" />
    </svg>
  );
}

