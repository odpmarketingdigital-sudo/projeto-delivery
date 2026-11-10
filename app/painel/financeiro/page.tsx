import { PainelFinanceiro } from "./PainelFinanceiro";

/**
 * Página de Extrato de Pagamentos / Financeiro do /painel (Server Component).
 *
 * A rota é protegida pelo guard do layout do /painel e pelo `GET
 * /api/financeiro` (que exige sessão e valida o estabelecimento). A
 * interatividade — cards de resumo, filtro por status e tabela do extrato —
 * vive em <PainelFinanceiro> (Client Component).
 */
export const instant = false;

export default function PainelFinanceiroPage() {
  return <PainelFinanceiro />;
}
