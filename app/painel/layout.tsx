import type { ReactNode } from "react";
import { OrderSoundProvider } from "./components/OrderSoundProvider";
import { PainelGuard } from "./PainelGuard";

/**
 * Layout do /painel (Server Component).
 *
 * Exporta `instant = false` porque o segmento depende de verificação de
 * sessão e de dados dinâmicos do cliente (perfil em `profiles`), e o guard
 * de autenticação decide condicionalmente o que renderizar. Isso desativa a
 * validação de Instant Navigation para o segmento (ele ainda é pré-renderizado
 * quando possível).
 *
 * A lógica interativa do guard vive em <PainelGuard> (Client Component), que
 * envolve {children} — o padrão recomendado para não remover o segmento da
 * árvore de renderização.
 */
export const instant = false;

export default function PainelLayout({ children }: { children: ReactNode }) {
  return (
    <PainelGuard>
      <OrderSoundProvider>{children}</OrderSoundProvider>
    </PainelGuard>
  );
}

