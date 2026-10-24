-- ============================================================================
--  Migração: cupons de desconto (Gestão de Cupons + checkout)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) Tabela `public.coupons` — cupons por estabelecimento, com desconto
--     percentual ou de valor fixo, pedido mínimo e limite global de usos.
--  2) Colunas de cupom em `public.orders` (código aplicado, desconto e vínculo).
--  3) RLS de leitura (dono/super admin) + função atômica de consumo de uso.
--
--  As escritas continuam exclusivas das rotas de API via service role
--  (bypass de RLS), mesmo padrão das demais tabelas do projeto.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabela de cupons
-- ---------------------------------------------------------------------------
create table if not exists public.coupons (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  code             text not null,
  discount_type    text not null default 'percentage'
                     check (discount_type in ('percentage', 'fixed')),
  discount_value   numeric(10, 2) not null
                     check (discount_value > 0),
  min_order_value  numeric(10, 2)
                     check (min_order_value is null or min_order_value >= 0),
  usage_limit      integer
                     check (usage_limit is null or usage_limit >= 1),
  used_count       integer not null default 0
                     check (used_count >= 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Complementa uma eventual versão pré-existente (equivalente a if not exists).
alter table public.coupons add column if not exists establishment_id uuid;
alter table public.coupons add column if not exists code             text;
alter table public.coupons add column if not exists discount_type    text not null default 'percentage';
alter table public.coupons add column if not exists discount_value   numeric(10, 2) not null default 0;
alter table public.coupons add column if not exists min_order_value  numeric(10, 2);
alter table public.coupons add column if not exists usage_limit      integer;
alter table public.coupons add column if not exists used_count       integer not null default 0;
alter table public.coupons add column if not exists active           boolean not null default true;
alter table public.coupons add column if not exists created_at       timestamptz not null default now();
alter table public.coupons add column if not exists updated_at       timestamptz not null default now();

-- Regras de integridade (idempotentes: ignoram constraints já existentes).
do $$
begin
  alter table public.coupons
    add constraint coupons_code_uppercase check (code = upper(code));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_discount_type_valid
    check (discount_type in ('percentage', 'fixed'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_discount_value_positive check (discount_value > 0);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_percentage_max
    check (discount_type <> 'percentage' or discount_value <= 100);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_min_order_non_negative
    check (min_order_value is null or min_order_value >= 0);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_usage_limit_positive
    check (usage_limit is null or usage_limit >= 1);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_used_count_non_negative check (used_count >= 0);
exception when duplicate_object then null;
end $$;

comment on table public.coupons is
  'Cupons de desconto por estabelecimento (percentual ou valor fixo).';
comment on column public.coupons.code is
  'Código do cupom em caixa alta (ex.: DESCONTO10).';
comment on column public.coupons.used_count is
  'Quantidade de usos confirmados; incrementada ao criar um pedido com o cupom.';

-- Código único por estabelecimento (case-insensitive, independente de caixa).
create unique index if not exists coupons_establishment_code_key
  on public.coupons (establishment_id, upper(code));

create index if not exists coupons_establishment_idx
  on public.coupons (establishment_id);
create index if not exists coupons_active_idx
  on public.coupons (active);

-- Mantém updated_at atualizado (reusa a função set_updated_at do schema.sql).
drop trigger if exists coupons_set_updated_at on public.coupons;
create trigger coupons_set_updated_at
  before update on public.coupons
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Cupom aplicado no pedido
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists coupon_id uuid
    references public.coupons (id) on delete set null,
  add column if not exists coupon_code text,
  add column if not exists coupon_discount numeric(10, 2) not null default 0;

create index if not exists orders_coupon_code_idx
  on public.orders (coupon_code);

-- ---------------------------------------------------------------------------
-- 3) RLS — leitura do dono e do super admin (escrita via service role)
-- ---------------------------------------------------------------------------
alter table public.coupons enable row level security;

drop policy if exists "coupons_select_owner" on public.coupons;
create policy "coupons_select_owner"
  on public.coupons
  for select
  using (
    exists (
      select 1
      from public.establishments e
      where e.id = coupons.establishment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "coupons_select_super_admin" on public.coupons;
create policy "coupons_select_super_admin"
  on public.coupons
  for select
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 4) Consumo atômico de uso do cupom
--    Retorna true quando o contador foi incrementado (cupom ativo e com
--    limite disponível). Evita que pedidos concorrentes ultrapassem o limite.
-- ---------------------------------------------------------------------------
create or replace function public.consume_coupon_usage(p_coupon_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_rows integer;
begin
  update public.coupons
     set used_count = used_count + 1
   where id = p_coupon_id
     and active
     and (usage_limit is null or used_count < usage_limit);

  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$$;

revoke all on function public.consume_coupon_usage(uuid) from public;
grant execute on function public.consume_coupon_usage(uuid) to service_role;
