import { PainelPedidos } from "./PainelPedidos";

/**
 * Página de Pedidos do /painel (Server Component).
 *
 * Exporta `instant = false` porque a rota é protegida por uma verificação de
 * sessão no cliente (guard no layout) e depende de dados dinâmicos. A
 * interatividade do Kanban vive em <PainelPedidos> (Client Component).
 */
export const instant = false;

export default function PainelPage() {
  return <PainelPedidos />;
}

