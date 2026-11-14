import { PainelWhatsappIa } from "./PainelWhatsappIa";

/**
 * Página do WhatsApp da loja no /painel (Server Component).
 *
 * A rota é protegida pelo guard do layout do /painel; a interatividade
 * (estado da conexão, "Conectar WhatsApp" com QR Code e "Desconectar") vive em
 * <PainelWhatsappIa>. Não há histórico de conversas: nada de mensagens é
 * persistido.
 */
export const instant = false;

export default function PainelWhatsappIaPage() {
  return <PainelWhatsappIa />;
}
