/**
 * GET/PUT/POST /api/establishment/ai — preferências do Atendente IA.
 *
 * Alias fino de `/api/whatsapp-ia`: mesma autenticação (dono da loja ou super
 * admin), mesmos handlers e mesmo formato de resposta. A implementação mora em
 * um único arquivo para o painel (`/painel/whatsapp-ia`) e o webhook nunca
 * divergirem.
 *
 *  - GET  → configuração atual (`ai_enabled`, `ai_assistant_name`,
 *           `ai_personality`, `ai_custom_instructions`, conexão do número) e
 *           metadados (personalidades, se a IA está configurada no ambiente);
 *  - PUT  → salva as preferências (parcial: só os campos enviados; valida
 *           personalidade e normaliza nome/instruções);
 *  - POST → ação de conexão da instância (`connect` | `status`).
 */
export { GET, POST, PUT } from "@/app/api/whatsapp-ia/route";
