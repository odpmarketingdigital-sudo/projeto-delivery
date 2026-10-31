import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Metadados de `/cadastro`.
 *
 * A página é um Client Component (formulário com estado), então o `metadata`
 * fica neste layout — padrão do App Router para rotas 100% interativas.
 */
export const metadata: Metadata = {
  title: "Criar conta",
  description:
    "Crie sua conta no Ipepper e coloque seu cardápio digital no ar: pedidos organizados, link próprio e trial grátis sem cartão de crédito.",
};

export default function CadastroLayout({ children }: { children: ReactNode }) {
  return children;
}
