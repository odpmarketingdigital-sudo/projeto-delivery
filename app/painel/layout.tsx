import type { ReactNode } from "react";
import { ensurePainelStore } from "@/lib/supabase/painelStoreGuard";
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
 * Antes de qualquer render, `ensurePainelStore()` (servidor) confirma que a
 * conta autenticada tem estabelecimento. Contas sem loja — típico de quem criou
 * a conta pelo Google e perdeu o rascunho do cadastro — são levadas para
 * `/completar-cadastro` em vez de ver o painel vazio.
 *
 * A lógica interativa do guard vive em <PainelGuard> (Client Component), que
 * envolve {children} — o padrão recomendado para não remover o segmento da
 * árvore de renderização.
 *
 * O painel usa um tema claro fixo (sidebar escura + conteúdo branco), mesmo
 * com o sistema operacional em modo escuro: o wrapper abaixo define as cores
 * base para que textos sem utilitário de cor herdem o tom escuro correto.
 */
export const instant = false;

export default async function PainelLayout({
  children,
}: {
  children: ReactNode;
}) {
  await ensurePainelStore();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <PainelGuard>
        <OrderSoundProvider>{children}</OrderSoundProvider>
      </PainelGuard>
    </div>
  );
}

