-- ============================================================================
--  Migração: configurações globais da plataforma (Etapa 4 — Super Admin)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Cria `public.system_settings`: um dicionário chave → valor (jsonb) para os
--  parâmetros globais da plataforma. O primeiro parâmetro é o preço mensal do
--  Plano Profissional, usado pelo checkout, pela tela de assinatura e pela
--  área do Super Admin.
--
--  Formato do valor do plano (jsonb):
--    { "amount_cents": 9700, "currency": "BRL" }
--  `amount_cents` = valor em CENTAVOS (9700 = R$ 97,00), evitando erros de
--  ponto flutuante. A leitura aceita também um número solto (ex.: 9700) e
--  uma string de reais (ex.: "97.00"), sempre por compatibilidade.
--
--  RLS: leitura apenas para Super Admin; escritas exclusivas das rotas de API
--  (service role key), como nas demais tabelas da plataforma.
-- ============================================================================

create table if not exists public.system_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  -- Quem alterou por último (null quando foi uma migração/seed).
  updated_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.system_settings is
  'Parâmetros globais da plataforma (chave → valor JSON), editáveis pelo Super Admin.';

comment on column public.system_settings.key is
  'Identificador do parâmetro (ex.: monthly_plan_price).';
comment on column public.system_settings.value is
  'Valor JSON do parâmetro. monthly_plan_price usa { amount_cents, currency }.';
comment on column public.system_settings.updated_by is
  'Usuário (auth.users) que alterou o parâmetro por último.';

-- Mantém updated_at atualizado (reusa a função set_updated_at do schema.sql).
drop trigger if exists system_settings_set_updated_at on public.system_settings;
create trigger system_settings_set_updated_at
  before update on public.system_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Seed: preço padrão do Plano Profissional (R$ 97,00/mês).
-- `on conflict do nothing` preserva qualquer valor já configurado no painel.
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value, description)
values (
  'monthly_plan_price',
  jsonb_build_object('amount_cents', 9700, 'currency', 'BRL'),
  'Preço mensal do Plano Profissional, em centavos (9700 = R$ 97,00).'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.system_settings enable row level security;

drop policy if exists "system_settings_select_super_admin" on public.system_settings;
create policy "system_settings_select_super_admin"
  on public.system_settings
  for select
  using (public.is_super_admin());
