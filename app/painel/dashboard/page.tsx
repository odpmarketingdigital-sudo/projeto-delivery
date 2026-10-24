import { PainelDashboard } from "./PainelDashboard";

/**
 * Dashboard de vendas do painel (Server Component).
 *
 * A interatividade (filtros de período + fetch) vive em <PainelDashboard>
 * (Client Component). A rota é protegida pelo guard do layout do /painel.
 */
export const instant = false;

export default function DashboardPage() {
  return <PainelDashboard />;
}
