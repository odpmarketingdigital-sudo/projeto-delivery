-- ============================================================================
--  Migração: regras avançadas de cupons (frete grátis, 1º pedido, validade)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Complementa 20261110000011_create_coupons.sql:
--   1) `discount_type` passa a aceitar 'free_shipping' (frete grátis) e
--      `discount_value` pode ser 0 nesse caso.
--   2) `usage_limit` é renomeado para `max_uses` (nome canônico usado pela
--      aplicação) e `min_order_value` recebe default 0 (não nulo).
--   3) Novas colunas: `first_order_only` e `expires_at`.
--   4) `orders.discount_amount` (desconto total concedido no pedido) com
--      backfill a partir de `orders.coupon_discount`.
--   5) `consume_coupon_usage` passa a respeitar `max_uses` e a validade.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Renomeia usage_limit → max_uses (preserva dados de bases já migradas)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'coupons'
       and column_name = 'usage_limit'
  ) and not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'coupons'
       and column_name = 'max_uses'
  ) then
    alter table public.coupons rename column usage_limit to max_uses;
  end if;
end $$;

alter table public.coupons add column if not exists max_uses integer;
alter table public.coupons
  add column if not exists first_order_only boolean not null default false;
alter table public.coupons add column if not exists expires_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2) Remove constraints antigas que impedem frete grátis / valor zero
-- ---------------------------------------------------------------------------
alter table public.coupons drop constraint if exists coupons_discount_type_valid;
alter table public.coupons drop constraint if exists coupons_discount_type_check;
alter table public.coupons drop constraint if exists coupons_discount_value_positive;
alter table public.coupons drop constraint if exists coupons_discount_value_check;
alter table public.coupons drop constraint if exists coupons_percentage_max;
alter table public.coupons drop constraint if exists coupons_usage_limit_positive;
alter table public.coupons drop constraint if exists coupons_min_order_non_negative;

-- ---------------------------------------------------------------------------
-- 3) Defaults e normalização de dados
-- ---------------------------------------------------------------------------
alter table public.coupons alter column discount_value set default 0;
alter table public.coupons alter column min_order_value set default 0;

update public.coupons set min_order_value = 0 where min_order_value is null;
update public.coupons
   set discount_value = 0
 where discount_type = 'free_shipping';

alter table public.coupons alter column min_order_value set not null;


-- ---------------------------------------------------------------------------
-- 4) Novas regras de integridade
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.coupons
    add constraint coupons_discount_type_valid
    check (discount_type in ('percentage', 'fixed', 'free_shipping'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_discount_value_non_negative
    check (discount_value >= 0);
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
    add constraint coupons_fixed_positive
    check (discount_type <> 'fixed' or discount_value > 0);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_free_shipping_zero
    check (discount_type <> 'free_shipping' or discount_value = 0);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_max_uses_positive
    check (max_uses is null or max_uses >= 1);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.coupons
    add constraint coupons_min_order_non_negative
    check (min_order_value >= 0);
exception when duplicate_object then null;
end $$;

comment on table public.coupons is
  'Cupons de desconto por estabelecimento (percentual, valor fixo ou frete grátis).';
comment on column public.coupons.max_uses is
  'Limite global de usos do cupom (null = ilimitado).';
comment on column public.coupons.first_order_only is
  'Quando true, só pode ser usado por clientes sem pedidos anteriores (não cancelados) na loja.';
comment on column public.coupons.expires_at is
  'Data/hora limite de validade do cupom (null = sem validade).';

-- ---------------------------------------------------------------------------
-- 5) Pedido: desconto total concedido (cupons fixos/percentuais/frete grátis)
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists discount_amount numeric(10, 2) not null default 0;

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'orders'
       and column_name = 'coupon_discount'
  ) then
    execute $sql$
      update public.orders
         set discount_amount = coupon_discount
       where coalesce(discount_amount, 0) = 0
         and coalesce(coupon_discount, 0) > 0
    $sql$;
  end if;
end $$;

comment on column public.orders.discount_amount is
  'Desconto total concedido no pedido (cupom fixo/percentual ou frete grátis).';

-- Índice para a checagem de "primeiro pedido" no checkout.
create index if not exists orders_establishment_phone_idx
  on public.orders (establishment_id, customer_phone);

-- ---------------------------------------------------------------------------
-- 6) Consumo atômico do cupom (max_uses + validade)
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
     and (expires_at is null or expires_at > now())
     and (max_uses is null or used_count < max_uses);

  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$$;

revoke all on function public.consume_coupon_usage(uuid) from public;
grant execute on function public.consume_coupon_usage(uuid) to service_role;
