import { PainelClientes } from "./PainelClientes";

/**
 * Página de Gestão/Histórico de Clientes do /painel (Server Component).
 *
 * A rota é protegida pelo guard do layout do /painel; a interatividade
 * (busca, tabela e modal de histórico) vive em <PainelClientes>.
 */
export const instant = false;

export default function PainelClientesPage() {
  return <PainelClientes />;
}
