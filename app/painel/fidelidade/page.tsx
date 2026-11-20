import { PainelFidelidade } from "./PainelFidelidade";

/**
 * Página de Fidelidade do /painel (Server Component).
 *
 * A rota é protegida pelo guard do layout do /painel; a configuração do
 * programa, a lista de participantes e o ajuste manual de pontos vivem em
 * <PainelFidelidade> (rotas /api/loyalty*).
 */
export const instant = false;

export default function PainelFidelidadePage() {
  return <PainelFidelidade />;
}
