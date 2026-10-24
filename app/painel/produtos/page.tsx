import { PainelProdutos } from "./PainelProdutos";

/**
 * Página de Gestão de Cardápio/Produtos do /painel (Server Component).
 *
 * Exporta `instant = false` porque a rota é protegida por verificação de
 * sessão no cliente (guard no layout) e depende de dados dinâmicos. A
 * interatividade (estabelecimento, categorias, produtos e modais) vive em
 * <PainelProdutos> (Client Component).
 */
export const instant = false;

export default function PainelProdutosPage() {
  return <PainelProdutos />;
}
