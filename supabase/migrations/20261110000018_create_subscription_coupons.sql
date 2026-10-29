-- ============================================================================
--  Migração: cupons de desconto da ASSINATURA (SaaS)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) Tabela `public.subscription_coupons` — cupons GLOBAIS criados pelo
--     Super Admin e aplicados no checkout da assinatura sobre o total do
--     período escolhido (mensal, semestral ou anual).
--  2) RLS de leitura para o Super Admin.
--  3) Função atômica de consumo de uso.
--
--  As escritas continuam exclusivas das rotas de API via service role
--  (bypass de RLS), mesmo padrão das demais tabelas do projeto.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabela de cupons da assinatura
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_coupons (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  discount_type  text not null default 'percentage'
                   check (discount_type in ('percentage', 'fixed')),
  discount_value numeric(10, 2) not null
                   check (discount_value > 0),
  usage_limit    integer
                   check (usage_limit is null or usage_limit >= 1),
  used_count     integer not null default 0
                   check (used_count >= 0),
  active         boolean not null default true,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Complementa uma eventual versão pré-existente (equivalente a if not exists).
alter table public.subscription_coupons add column if not exists code           text;
alter table public.subscription_coupons add column if not exists discount_type  text not null default 'percentage';
alter table public.subscription_coupons add column if not exists discount_value numeric(10, 2) not null default 0;
alter table public.subscription_coupons add column if not exists usage_limit    integer;
alter table public.subscription_coupons add column if not exists used_count     integer not null default 0;
alter table public.subscription_coupons add column if not exists active         boolean not null default true;
alter table public.subscription_coupons add column if not exists created_by     uuid;
alter table public.subscription_coupons add column if not exists created_at     timestamptz not null default now();
alter table public.subscription_coupons add column if not exists updated_at     timestamptz not null default now();

-- Regras de integridade (idempotentes: ignoram constraints já existentes).
do $$
begin
  alter table public.subscription_coupons
    add constraint subscription_coupons_code_uppercase check (code = upper(code));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.subscription_coupons
    add constraint subscription_coupons_discount_type_valid
    check (discount_type in ('percentage', 'fixed'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.subscription_coupons
    add constraint subscription_coupons_discount_value_positive
    check (discount_value > 0);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.subscription_coupons
    add constraint subscription_coupons_percentage
    check (discount_type <> 'percentage' or discount_value <= 100);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.subscription_coupons
    add constraint subscription_coupons_usage_limit_positive
    check (usage_limit is null or usage_limit >= 1);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.subscription_coupons
    add constraint subscription_coupons_used_count_non_negative
    check (used_count >= 0);
exception when duplicate_object then null;
end $$;

comment on table public.subscription_coupons is
  'Cupons globais da assinatura do Ipepper (aplicados no checkout do plano).';
comment on column public.subscription_coupons.code is
  'Código do cupom em caixa alta (ex.: BEMVINDO10).';
comment on column public.subscription_coupons.discount_value is
  'Percentual (0-100) quando discount_type = percentage; valor em reais quando fixed.';
comment on column public.subscription_coupons.used_count is
  'Quantidade de assinaturas contratadas com o cupom.';

-- Código único global (case-insensitive).
create unique index if not exists subscription_coupons_code_key
  on public.subscription_coupons (upper(code));

create index if not exists subscription_coupons_active_idx
  on public.subscription_coupons (active);

-- Mantém updated_at atualizado (reusa a função set_updated_at do schema.sql).
drop trigger if exists subscription_coupons_set_updated_at on public.subscription_coupons;
create trigger subscription_coupons_set_updated_at
  before update on public.subscription_coupons
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) RLS — leitura apenas do Super Admin (escrita via service role)
-- ---------------------------------------------------------------------------
alter table public.subscription_coupons enable row level security;

drop policy if exists "subscription_coupons_select_super_admin"
  on public.subscription_coupons;
create policy "subscription_coupons_select_super_admin"
  on public.subscription_coupons
  for select
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 3) Consumo atômico de uso do cupom
--    Retorna true quando o contador foi incrementado (cupom ativo e com
--    limite disponível). Evita que checkouts concorrentes ultrapassem o limite.
-- ---------------------------------------------------------------------------
create or replace function public.consume_subscription_coupon_usage(
  p_coupon_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_rows integer;
begin
  update public.subscription_coupons
     set used_count = used_count + 1
   where id = p_coupon_id
     and active
     and (usage_limit is null or used_count < usage_limit);

  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$$;

revoke all on function public.consume_subscription_coupon_usage(uuid) from public;
grant execute on function public.consume_subscription_coupon_usage(uuid) to service_role;

