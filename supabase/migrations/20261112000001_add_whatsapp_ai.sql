-- ============================================================================
--  Migração: Atendente IA no WhatsApp (Fase 1) — schema base
--  Execute no SQL Editor do Supabase. Arquivo 100% idempotente: pode rodar
--  depois de `20261111000005_add_ai_whatsapp_assistant.sql` sem erro.
--
--  1) `public.establishments` — configuração do atendente virtual:
--     ai_enabled, ai_assistant_name, ai_personality, ai_custom_instructions,
--     whatsapp_instance_name, whatsapp_connected.
--
--  Escrita: apenas service role (painel via `/api/whatsapp-ia`). A loja lê o
--  próprio estado de conexão; a configuração da IA é do Superadmin.
--
--  **Sem histórico de conversas**: o webhook (`/api/webhooks/whatsapp`)
--  responde pelo Gemini sem gravar mensagens. O contexto de curto prazo e a
--  pausa da IA ficam em memória no processo do servidor
--  (`lib/whatsapp/conversationMemory.ts`).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Configuração do atendente em `public.establishments`
-- ---------------------------------------------------------------------------
alter table public.establishments
  add column if not exists ai_enabled boolean not null default false,
  add column if not exists ai_assistant_name text not null default 'Atendente Virtual',
  add column if not exists ai_personality text not null default 'simpatico',
  add column if not exists ai_custom_instructions text,
  add column if not exists whatsapp_instance_name text,
  add column if not exists whatsapp_connected boolean not null default false;

-- Bases legadas: normaliza nulos/vazios antes de reforçar defaults/constraints.
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

update public.establishments
   set whatsapp_instance_name = null
 where whatsapp_instance_name is not null and btrim(whatsapp_instance_name) = '';

alter table public.establishments
  alter column ai_enabled set default false,
  alter column ai_enabled set not null,
  alter column ai_assistant_name set default 'Atendente Virtual',
  alter column ai_assistant_name set not null,
  alter column ai_personality set default 'simpatico',
  alter column ai_personality set not null,
  alter column whatsapp_connected set default false,
  alter column whatsapp_connected set not null;

-- Uma instância da Evolution API atende uma única loja.
create unique index if not exists establishments_whatsapp_instance_name_key
  on public.establishments (whatsapp_instance_name)
  where whatsapp_instance_name is not null;

comment on column public.establishments.ai_enabled is
  'Liga o atendimento automático por IA no WhatsApp (padrão false).';
comment on column public.establishments.ai_personality is
  'Tom de voz da IA: simpatico | direto | formal.';
comment on column public.establishments.whatsapp_instance_name is
  'Nome da instância da Evolution API que atende esta loja (único).';
comment on column public.establishments.whatsapp_connected is
  'Último estado de conexão conhecido do número na Evolution API.';

