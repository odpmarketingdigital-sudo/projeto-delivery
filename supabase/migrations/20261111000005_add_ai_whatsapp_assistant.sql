-- ============================================================================
--  Migração: Atendente virtual de IA no WhatsApp (Fase 1)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) `establishments` — configuração do atendente virtual:
--     - ai_enabled              liga/desliga o atendimento automático
--                               (padrão false: nenhuma loja responde sozinha
--                               antes de a loja ativar);
--     - ai_assistant_name       nome que a IA usa para se apresentar;
--     - ai_personality          tom de voz: 'simpatico' | 'direto' | 'formal';
--     - ai_custom_instructions  instruções livres da loja (NULL = nenhuma);
--     - whatsapp_instance_name  nome da instância na Evolution API
--                               (único — cada instância atende UMA loja);
--     - whatsapp_connected      último estado de conexão conhecido do número.
--
--  Regras:
--   - Escrita exclusiva da service role (`/api/whatsapp-ia`); a loja lê o
--     próprio estado de conexão e o Superadmin configura a IA.
--   - **Sem histórico de conversas**: o webhook (`/api/webhooks/whatsapp`)
--     responde pelo Gemini sem gravar mensagens no banco. O contexto de curto
--     prazo e a pausa da IA (loja respondeu pelo app) ficam em memória no
--     processo do servidor (`lib/whatsapp/conversationMemory.ts`).
--   - Compatibilidade: enquanto esta migração não rodar as colunas simplesmente
--     não existem — o restante do sistema segue funcionando e o painel avisa
--     que a migração está pendente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Configuração do atendente virtual em `establishments`
-- ---------------------------------------------------------------------------
alter table public.establishments
  add column if not exists ai_enabled boolean not null default false,
  add column if not exists ai_assistant_name text not null default 'Atendente Virtual',
  add column if not exists ai_personality text not null default 'simpatico',
  add column if not exists ai_custom_instructions text,
  add column if not exists whatsapp_instance_name text,
  add column if not exists whatsapp_connected boolean not null default false;

-- Bases legadas: normaliza nulos/formatos inesperados antes das constraints.
update public.establishments
   set ai_enabled = false
 where ai_enabled is null;

update public.establishments
   set ai_assistant_name = 'Atendente Virtual'
 where ai_assistant_name is null or btrim(ai_assistant_name) = '';

update public.establishments
   set ai_personality = 'simpatico'
 where ai_personality is null
    or ai_personality not in ('simpatico', 'direto', 'formal');

update public.establishments
   set whatsapp_connected = false
 where whatsapp_connected is null;

alter table public.establishments
  alter column ai_enabled set default false,
  alter column ai_enabled set not null,
  alter column ai_assistant_name set default 'Atendente Virtual',
  alter column ai_assistant_name set not null,
  alter column ai_personality set default 'simpatico',
  alter column ai_personality set not null,
  alter column whatsapp_connected set default false,
  alter column whatsapp_connected set not null;

do $$
begin
  alter table public.establishments
    add constraint establishments_ai_personality_check
    check (ai_personality in ('simpatico', 'direto', 'formal'));
exception when duplicate_object then null;
end
$$;

-- Uma instância da Evolution API pertence a uma única loja (o webhook resolve a
-- loja pelo nome da instância que recebeu a mensagem).
create unique index if not exists establishments_whatsapp_instance_name_key
  on public.establishments (whatsapp_instance_name)
  where whatsapp_instance_name is not null;

comment on column public.establishments.ai_enabled is
  'Quando true, o atendente virtual responde automaticamente as mensagens do WhatsApp.';
comment on column public.establishments.ai_assistant_name is
  'Nome usado pela IA para se apresentar ao cliente.';
comment on column public.establishments.ai_personality is
  'Tom de voz do atendente virtual: simpatico | direto | formal.';
comment on column public.establishments.ai_custom_instructions is
  'Instruções livres da loja acrescentadas ao prompt do atendente virtual (NULL = nenhuma).';
comment on column public.establishments.whatsapp_instance_name is
  'Nome da instância da Evolution API vinculada à loja (único).';
comment on column public.establishments.whatsapp_connected is
  'Último estado de conexão conhecido do número de WhatsApp da loja.';

