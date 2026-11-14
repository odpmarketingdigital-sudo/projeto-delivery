-- ============================================================================
--  Migração: remove o histórico de conversas de WhatsApp
--  Execute no SQL Editor do Supabase (idempotente).
--
--  O Ipepper não persiste mais chat:
--   - o painel da loja não tem lista de conversas nem campo de resposta;
--   - o webhook da Evolution API + Gemini continua respondendo os clientes,
--     mas nenhuma mensagem é gravada no banco (o contexto de curto prazo e a
--     pausa da IA ficam em memória: `lib/whatsapp/conversationMemory.ts`).
--
--  `whatsapp_messages` depende de `whatsapp_conversations` (FK ON DELETE
--  CASCADE): as duas tabelas caem juntas, com índices, constraints e policies.
--  As colunas de IA em `public.establishments` (ai_enabled, ai_assistant_name,
--  ai_personality, ai_custom_instructions, whatsapp_instance_name e
--  whatsapp_connected) são mantidas — são a configuração do atendente.
-- ============================================================================

drop table if exists public.whatsapp_messages;
drop table if exists public.whatsapp_conversations;
