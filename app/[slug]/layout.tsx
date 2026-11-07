import type { ReactNode } from "react";

/**
 * Layout do fluxo público do cliente.
 *
 * Aplica-se a `/[slug]` (cardápio), `/[slug]/checkout` (finalizar pedido) e
 * `/[slug]/pedidos` (Meus Pedidos) — todo o caminho de compra do cliente.
 *
 * Essas telas precisam ser SEMPRE claras, independentemente do tema do sistema
 * operacional/navegador do visitante. O variant `dark:` do Tailwind já foi
 * trocado para a estratégia baseada em classe em `app/globals.css` (nenhum
 * `.dark` é aplicado), então nenhum componente escurece pela preferência do SO.
 * Este layout reforça/explicita o tema claro de duas formas:
 *
 *  - `color-scheme: light`: faz os controles NATIVOS do navegador (inputs,
 *    selects, date pickers, autofill, scrollbars) renderizarem no esquema claro
 *    mesmo com o SO em modo escuro — sem isso, esses widgets herdariam o tema
 *    escuro e ficariam com contraste ruim sobre o fundo claro da loja.
 *  - cores base claras (fundo/texto) no wrapper, para que textos sem utilitário
 *    de cor herdem o tom escuro correto — mesmo padrão adotado em
 *    `app/painel/layout.tsx`.
 */
export default function SlugLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen bg-gray-50 text-gray-900"
      style={{ colorScheme: "light" }}
    >
      {children}
    </div>
  );
}
