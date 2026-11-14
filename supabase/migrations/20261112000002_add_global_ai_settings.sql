-- ============================================================================
--  Migração: configuração GLOBAL do atendente IA (Superadmin)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Separa o que é da PLATAFORMA do que é da LOJA:
--
--   • Plataforma (Superadmin) — `public.system_settings`, chave → jsonb:
--       - ai_master_prompt         { text }      prompt mestre do atendimento;
--       - ai_default_personality   { value }     tom de voz padrão;
--       - whatsapp_instance_prefix { value }     prefixo das instâncias;
--       - ai_models                { models[] }  cadeia de modelos Gemini.
--     Leitura: RLS de `system_settings` já restrita ao Superadmin
--     (migração 20261110000013). Escrita: apenas service role
--     (`/api/admin/ai-settings`).
--
--   • Loja (estabelecimento) — colunas de `public.establishments`:
--       - ai_enabled, ai_assistant_name, ai_custom_instructions (observações);
--       - ai_personality/whatsapp_instance_name/whatsapp_connected permanecem
--         por compatibilidade, mas o painel do lojista não os edita mais:
--         tom de voz e instância são geridos pela plataforma.
--
--  O prompt mestre NÃO é seedado aqui de propósito: enquanto a chave não
--  existir, o código usa `DEFAULT_AI_MASTER_PROMPT`
--  (`lib/whatsappAssistant.ts`) como padrão de fábrica. Isso evita duas cópias
--  do mesmo texto (SQL + TypeScript) saírem de sincronia.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Parâmetros globais com valor simples (seed idempotente)
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value, description)
values (
  'ai_default_personality',
  jsonb_build_object('value', 'simpatico'),
  'Tom de voz padrão do atendente virtual de WhatsApp (simpatico | direto | formal).'
)
on conflict (key) do nothing;

insert into public.system_settings (key, value, description)
values (
  'whatsapp_instance_prefix',
  jsonb_build_object('value', 'ipepper'),
  'Prefixo das instâncias da Evolution API (nome final: prefixo-slug-da-loja).'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Comentários das colunas — documenta a fronteira dentro do próprio banco
-- ---------------------------------------------------------------------------
comment on column public.establishments.ai_assistant_name is
  'Nome com que o atendente virtual se apresenta ao cliente (editável pela loja).';

comment on column public.establishments.ai_custom_instructions is
  'Observações operacionais da loja usadas no prompt (editável pela loja). Não substitui o prompt mestre da plataforma.';

comment on column public.establishments.ai_personality is
  'Legado: o tom de voz em uso vem de system_settings.ai_default_personality (Superadmin).';

comment on column public.establishments.whatsapp_instance_name is
  'Instância da Evolution API gerida pela plataforma (prefixo + slug). Única por loja.';

-- ---------------------------------------------------------------------------
-- 3) RLS defensiva em `system_settings` (leitura só Superadmin)
--
--    `create policy` não aceita `if not exists`: o bloco abaixo garante a
--    política mesmo em bancos onde a migração 20261110000013 rodou parcialmente.
--    Não há policy de INSERT/UPDATE/DELETE — sem elas, a RLS bloqueia escrita
--    de `authenticated`/`anon`; as gravações acontecem só via service role.
-- ---------------------------------------------------------------------------
alter table public.system_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'system_settings'
       and policyname = 'system_settings_select_super_admin'
  ) then
    create policy "system_settings_select_super_admin"
      on public.system_settings
      for select
      using (public.is_super_admin());
  end if;
end
$$;

comment on table public.system_settings is
  'Parâmetros globais da plataforma (chave → valor JSON), editáveis apenas pelo Super Admin.';
