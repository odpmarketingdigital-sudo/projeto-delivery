import { PainelAdminIa } from "./PainelAdminIa";

/**
 * Configuração global do atendente IA — `/painel/admin/ia` (Superadmin).
 *
 * Rota protegida pelo `PainelGuard` (que bloqueia `/painel/admin/*` para quem
 * não é `super_admin`) e pela API `/api/admin/ai-settings`, que repete a
 * checagem com `requireSuperAdmin`. Aqui ficam prompt mestre, tom de voz,
 * modelos, chaves (status) e as instâncias de WhatsApp das lojas.
 *
 * A loja continua com `/painel/whatsapp-ia`, que só trata do que é operacional.
 */
export const instant = false;

export default function PainelAdminIaPage() {
  return <PainelAdminIa />;
}
