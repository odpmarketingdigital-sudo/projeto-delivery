import { PainelCupons } from "./PainelCupons";

/**
 * Página de Gestão de Cupons do /painel (Server Component).
 *
 * A rota é protegida pelo guard do layout do /painel; a interatividade
 * (listagem, criação/edição/exclusão) vive em <PainelCupons>.
 */
export const instant = false;

export default function PainelCuponsPage() {
  return <PainelCupons />;
}
