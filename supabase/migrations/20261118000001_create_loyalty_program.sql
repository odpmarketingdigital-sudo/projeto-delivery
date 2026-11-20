-- ============================================================================
--  Migração: programa de fidelidade (pontos por estabelecimento)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) `public.loyalty_programs` — configuração 1:1 por estabelecimento:
--     pontos ganhos por real gasto, pontos necessários por prêmio, tipo/valor
--     do prêmio e pedido mínimo para resgatar.
--  2) `public.customer_loyalty` — saldo de pontos por cliente, chaveado por
--     `establishment_id` + telefone (somente dígitos).
--  3) `public.loyalty_transactions` — histórico auditável (ganho, resgate,
--     estorno e ajuste manual) com idempotência por `(order_id, kind)`.
--  4) Colunas de fidelidade em `public.orders`.
--  5) Funções atômicas de crédito/resgate/ajuste + RLS de leitura.
--
--  Regras:
--   - O painel (`/painel/fidelidade`) grava a configuração via
--     `PUT /api/loyalty` e ajusta saldos via `POST /api/loyalty/adjust`;
--   - O checkout consulta `POST /api/loyalty/status` e aplica o resgate em
--     `POST /api/orders` (o servidor é a fonte da verdade);
--   - Os pontos são creditados uma única vez quando o pedido entra em
--     `finalizado` (`PUT /api/orders`) e devolvidos se o pedido for cancelado.
--
--  Escritas continuam exclusivas das rotas de API via service role
--  (bypass de RLS), mesmo padrão das demais tabelas do projeto.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Configuração do programa por estabelecimento
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_programs (
  id                uuid primary key default gen_random_uuid(),
  establishment_id  uuid not null unique
                      references public.establishments (id) on delete cascade,
  enabled           boolean not null default false,
  points_per_real   numeric(10, 2) not null default 1
                      check (points_per_real > 0),
  points_per_reward integer not null default 100
                      check (points_per_reward >= 1),
  reward_type       text not null default 'fixed_discount'
                      check (reward_type in ('fixed_discount', 'percentage_discount', 'free_shipping')),
  reward_value      numeric(10, 2) not null default 10
                      check (reward_value >= 0),
  min_order_value   numeric(10, 2) not null default 0
                      check (min_order_value >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Complementa uma eventual versão pré-existente (equivalente a if not exists).
alter table public.loyalty_programs add column if not exists establishment_id  uuid;
alter table public.loyalty_programs add column if not exists enabled           boolean not null default false;
alter table public.loyalty_programs add column if not exists points_per_real   numeric(10, 2) not null default 1;
alter table public.loyalty_programs add column if not exists points_per_reward integer not null default 100;
alter table public.loyalty_programs add column if not exists reward_type       text not null default 'fixed_discount';
alter table public.loyalty_programs add column if not exists reward_value      numeric(10, 2) not null default 10;
alter table public.loyalty_programs add column if not exists min_order_value   numeric(10, 2) not null default 0;
alter table public.loyalty_programs add column if not exists created_at        timestamptz not null default now();
alter table public.loyalty_programs add column if not exists updated_at        timestamptz not null default now();

-- Regras de integridade (idempotentes: ignoram constraints já existentes).
do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_reward_type_valid
    check (reward_type in ('fixed_discount', 'percentage_discount', 'free_shipping'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_points_per_real_positive
    check (points_per_real > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_points_per_reward_positive
    check (points_per_reward >= 1);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_reward_value_non_negative
    check (reward_value >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_percentage_range
    check (reward_type <> 'percentage_discount' or reward_value <= 100);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_min_order_value_non_negative
    check (min_order_value >= 0);
exception when duplicate_object then null; end $$;

comment on table public.loyalty_programs is
  'Configuração do programa de fidelidade por estabelecimento (1 linha por loja).';
comment on column public.loyalty_programs.enabled is
  'Liga/desliga o programa na vitrine e no checkout.';
comment on column public.loyalty_programs.points_per_real is
  'Pontos concedidos por R$ 1,00 gasto no pedido (base: subtotal após descontos).';
comment on column public.loyalty_programs.points_per_reward is
  'Pontos necessários para trocar por 1 prêmio.';
comment on column public.loyalty_programs.reward_type is
  'fixed_discount (R$), percentage_discount (%) ou free_shipping (frete grátis).';
comment on column public.loyalty_programs.reward_value is
  'Valor do prêmio: reais no desconto fixo, percentual (0-100) no desconto percentual.';
comment on column public.loyalty_programs.min_order_value is
  'Subtotal mínimo dos itens para permitir o resgate. 0 = sem mínimo.';

-- Mantém updated_at atualizado (reusa a função set_updated_at do schema.sql).
drop trigger if exists loyalty_programs_set_updated_at on public.loyalty_programs;
create trigger loyalty_programs_set_updated_at
  before update on public.loyalty_programs
  for each row execute function public.set_updated_at();
-- ---------------------------------------------------------------------------
-- 2) Saldo de pontos por cliente (telefone normalizado: somente dígitos)
-- ---------------------------------------------------------------------------
create table if not exists public.customer_loyalty (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  customer_phone   text not null,
  customer_name    text,
  points_balance   integer not null default 0
                     check (points_balance >= 0),
  total_earned     integer not null default 0
                     check (total_earned >= 0),
  rewards_redeemed integer not null default 0
                     check (rewards_redeemed >= 0),
  last_order_id    uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.customer_loyalty add column if not exists establishment_id uuid;
alter table public.customer_loyalty add column if not exists customer_phone   text;
alter table public.customer_loyalty add column if not exists customer_name    text;
alter table public.customer_loyalty add column if not exists points_balance   integer not null default 0;
alter table public.customer_loyalty add column if not exists total_earned     integer not null default 0;
alter table public.customer_loyalty add column if not exists rewards_redeemed integer not null default 0;
alter table public.customer_loyalty add column if not exists last_order_id    uuid;
alter table public.customer_loyalty add column if not exists created_at       timestamptz not null default now();
alter table public.customer_loyalty add column if not exists updated_at       timestamptz not null default now();

-- Um saldo por telefone em cada loja (base das funções `on conflict`).
do $$ begin
  alter table public.customer_loyalty
    add constraint customer_loyalty_establishment_phone_key
    unique (establishment_id, customer_phone);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.customer_loyalty
    add constraint customer_loyalty_balance_non_negative
    check (points_balance >= 0);
exception when duplicate_object then null; end $$;

create index if not exists customer_loyalty_establishment_idx
  on public.customer_loyalty (establishment_id);
create index if not exists customer_loyalty_ranking_idx
  on public.customer_loyalty (establishment_id, points_balance desc);

comment on table public.customer_loyalty is
  'Saldo de pontos do programa de fidelidade por telefone e estabelecimento.';
comment on column public.customer_loyalty.customer_phone is
  'Telefone do cliente somente com dígitos (mesmo formato de orders.customer_phone).';
comment on column public.customer_loyalty.points_balance is
  'Saldo atual de pontos (nunca negativo: resgates exigem saldo suficiente).';
comment on column public.customer_loyalty.rewards_redeemed is
  'Quantidade de prêmios já resgatados por este cliente.';

drop trigger if exists customer_loyalty_set_updated_at on public.customer_loyalty;
create trigger customer_loyalty_set_updated_at
  before update on public.customer_loyalty
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) Histórico de movimentações de pontos
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_transactions (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  customer_phone   text not null,
  order_id         uuid references public.orders (id) on delete set null,
  kind             text not null
                     check (kind in ('earn', 'redeem', 'refund', 'adjust')),
  points           integer not null
                     check (points <> 0),
  balance_after    integer not null default 0,
  description      text,
  created_at       timestamptz not null default now()
);

alter table public.loyalty_transactions add column if not exists establishment_id uuid;
alter table public.loyalty_transactions add column if not exists customer_phone   text;
alter table public.loyalty_transactions add column if not exists order_id         uuid;
alter table public.loyalty_transactions add column if not exists kind             text;
alter table public.loyalty_transactions add column if not exists points           integer;
alter table public.loyalty_transactions add column if not exists balance_after    integer not null default 0;
alter table public.loyalty_transactions add column if not exists description      text;
alter table public.loyalty_transactions add column if not exists created_at       timestamptz not null default now();

do $$ begin
  alter table public.loyalty_transactions
    add constraint loyalty_transactions_kind_valid
    check (kind in ('earn', 'redeem', 'refund', 'adjust'));
exception when duplicate_object then null; end $$;

-- Idempotência: cada pedido credita/resgata/estorna no máximo uma vez.
-- Ajustes manuais (order_id nulo) nunca colidem entre si.
create unique index if not exists loyalty_transactions_order_kind_key
  on public.loyalty_transactions (order_id, kind);

create index if not exists loyalty_transactions_customer_idx
  on public.loyalty_transactions (establishment_id, customer_phone, created_at desc);

comment on table public.loyalty_transactions is
  'Extrato de pontos do programa de fidelidade (ganho, resgate, estorno e ajuste).';
comment on column public.loyalty_transactions.points is
  'Pontos movimentados: positivo no ganho/estorno/ajuste, negativo no resgate.';
comment on column public.loyalty_transactions.kind is
  'earn (pedido finalizado), redeem (prêmio resgatado), refund (pedido cancelado) ou adjust (painel).';

-- ---------------------------------------------------------------------------
-- 4) Fidelidade aplicada no pedido
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists loyalty_points_redeemed integer not null default 0,
  add column if not exists loyalty_discount numeric(10, 2) not null default 0,
  add column if not exists loyalty_points_earned integer not null default 0;

comment on column public.orders.loyalty_points_redeemed is
  'Pontos consumidos pelo resgate de fidelidade neste pedido (0 = sem resgate).';
comment on column public.orders.loyalty_discount is
  'Desconto concedido pelo resgate de fidelidade (já abatido de orders.total).';
comment on column public.orders.loyalty_points_earned is
  'Pontos creditados quando o pedido entra em finalizado (idempotente por pedido).';

-- ---------------------------------------------------------------------------
-- 5) Funções atômicas de pontos
--    SECURITY DEFINER: chamadas apenas com a service role (rotas de API).
-- ---------------------------------------------------------------------------

-- Crédito/estorno: soma pontos ao saldo do telefone. Idempotente por
-- (order_id, kind) — reprocessar o mesmo pedido não duplica pontos.
create or replace function public.loyalty_add_points(
  p_establishment_id uuid,
  p_phone text,
  p_customer_name text default null,
  p_points integer default 0,
  p_order_id uuid default null,
  p_kind text default 'earn',
  p_description text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone   text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_kind    text := lower(coalesce(p_kind, 'earn'));
  v_rows    integer := 0;
  v_balance integer;
begin
  if p_establishment_id is null or p_points is null or p_points <= 0 then
    return null;
  end if;
  if length(v_phone) < 10 then
    return null;
  end if;
  if v_kind not in ('earn', 'refund', 'adjust') then
    return null;
  end if;

  insert into public.loyalty_transactions (
    establishment_id, customer_phone, order_id, kind, points, description
  ) values (
    p_establishment_id, v_phone, p_order_id, v_kind, p_points, p_description
  )
  on conflict (order_id, kind) do nothing;

  get diagnostics v_rows = row_count;

  -- Movimento repetido (pedido já processado): devolve o saldo atual.
  if v_rows = 0 then
    select points_balance into v_balance
      from public.customer_loyalty
     where establishment_id = p_establishment_id
       and customer_phone = v_phone;
    return coalesce(v_balance, 0);
  end if;

  insert into public.customer_loyalty (
    establishment_id, customer_phone, customer_name,
    points_balance, total_earned, last_order_id
  ) values (
    p_establishment_id,
    v_phone,
    nullif(btrim(coalesce(p_customer_name, '')), ''),
    p_points,
    p_points,
    p_order_id
  )
  on conflict (establishment_id, customer_phone) do update
     set points_balance = public.customer_loyalty.points_balance + excluded.points_balance,
         total_earned   = public.customer_loyalty.total_earned + excluded.total_earned,
         customer_name  = coalesce(excluded.customer_name, public.customer_loyalty.customer_name),
         last_order_id  = coalesce(excluded.last_order_id, public.customer_loyalty.last_order_id),
         updated_at     = now()
  returning points_balance into v_balance;

  update public.loyalty_transactions
     set balance_after = v_balance
   where establishment_id = p_establishment_id
     and customer_phone = v_phone
     and kind = v_kind
     and order_id is not distinct from p_order_id
     and balance_after = 0;

  return v_balance;
end;
$$;

revoke all on function public.loyalty_add_points(uuid, text, text, integer, uuid, text, text) from public;
grant execute on function public.loyalty_add_points(uuid, text, text, integer, uuid, text, text) to service_role;

-- Resgate: debita pontos do saldo. Retorna o novo saldo ou `null` quando o
-- cliente não tem pontos suficientes (o pedido NÃO deve receber o desconto).
-- Idempotente por pedido: um resgate por `order_id`.
create or replace function public.loyalty_redeem_points(
  p_establishment_id uuid,
  p_phone text,
  p_points integer,
  p_order_id uuid default null,
  p_description text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone   text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_balance integer;
begin
  if p_establishment_id is null or p_points is null or p_points <= 0 then
    return null;
  end if;
  if length(v_phone) < 10 then
    return null;
  end if;

  if p_order_id is not null
     and exists (
       select 1
         from public.loyalty_transactions
        where order_id = p_order_id
          and kind = 'redeem'
     ) then
    select points_balance into v_balance
      from public.customer_loyalty
     where establishment_id = p_establishment_id
       and customer_phone = v_phone;
    return coalesce(v_balance, 0);
  end if;

  update public.customer_loyalty
     set points_balance   = points_balance - p_points,
         rewards_redeemed = rewards_redeemed + 1,
         updated_at       = now()
   where establishment_id = p_establishment_id
     and customer_phone = v_phone
     and points_balance >= p_points
  returning points_balance into v_balance;

  if v_balance is null then
    return null;
  end if;

  insert into public.loyalty_transactions (
    establishment_id, customer_phone, order_id, kind, points, balance_after, description
  ) values (
    p_establishment_id, v_phone, p_order_id, 'redeem', -p_points, v_balance, p_description
  )
  on conflict (order_id, kind) do nothing;

  return v_balance;
end;
$$;

revoke all on function public.loyalty_redeem_points(uuid, text, integer, uuid, text) from public;
grant execute on function public.loyalty_redeem_points(uuid, text, integer, uuid, text) to service_role;

-- Ajuste manual do painel: aceita delta positivo (crédito) ou negativo
-- (débito). O saldo nunca fica abaixo de zero e o movimento fica registrado
-- no extrato como `adjust` (order_id nulo).
create or replace function public.loyalty_adjust_points(
  p_establishment_id uuid,
  p_phone text,
  p_customer_name text,
  p_delta integer,
  p_description text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone   text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_name    text := nullif(btrim(coalesce(p_customer_name, '')), '');
  v_balance integer;
begin
  if p_establishment_id is null or p_delta is null or p_delta = 0 then
    return null;
  end if;
  if length(v_phone) < 10 then
    return null;
  end if;

  insert into public.customer_loyalty (
    establishment_id, customer_phone, customer_name,
    points_balance, total_earned
  ) values (
    p_establishment_id, v_phone, v_name,
    greatest(p_delta, 0), greatest(p_delta, 0)
  )
  on conflict (establishment_id, customer_phone) do update
     set points_balance = greatest(public.customer_loyalty.points_balance + p_delta, 0),
         total_earned   = public.customer_loyalty.total_earned + greatest(p_delta, 0),
         customer_name  = coalesce(v_name, public.customer_loyalty.customer_name),
         updated_at     = now()
  returning points_balance into v_balance;

  insert into public.loyalty_transactions (
    establishment_id, customer_phone, kind, points, balance_after, description
  ) values (
    p_establishment_id, v_phone, 'adjust', p_delta, v_balance, p_description
  );

  return v_balance;
end;
$$;

revoke all on function public.loyalty_adjust_points(uuid, text, text, integer, text) from public;
grant execute on function public.loyalty_adjust_points(uuid, text, text, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6) RLS — leitura do dono e do super admin (escrita via service role)
-- ---------------------------------------------------------------------------
alter table public.loyalty_programs enable row level security;
alter table public.customer_loyalty enable row level security;
alter table public.loyalty_transactions enable row level security;

drop policy if exists "loyalty_programs_select_owner" on public.loyalty_programs;
create policy "loyalty_programs_select_owner" on public.loyalty_programs
  for select using (
    exists (
      select 1
        from public.establishments e
       where e.id = loyalty_programs.establishment_id
         and e.user_id = auth.uid()
    )
  );

drop policy if exists "loyalty_programs_select_super_admin" on public.loyalty_programs;
create policy "loyalty_programs_select_super_admin" on public.loyalty_programs
  for select using (public.is_super_admin());

drop policy if exists "customer_loyalty_select_owner" on public.customer_loyalty;
create policy "customer_loyalty_select_owner" on public.customer_loyalty
  for select using (
    exists (
      select 1
        from public.establishments e
       where e.id = customer_loyalty.establishment_id
         and e.user_id = auth.uid()
    )
  );

drop policy if exists "customer_loyalty_select_super_admin" on public.customer_loyalty;
create policy "customer_loyalty_select_super_admin" on public.customer_loyalty
  for select using (public.is_super_admin());

drop policy if exists "loyalty_transactions_select_owner" on public.loyalty_transactions;
create policy "loyalty_transactions_select_owner" on public.loyalty_transactions
  for select using (
    exists (
      select 1
        from public.establishments e
       where e.id = loyalty_transactions.establishment_id
         and e.user_id = auth.uid()
    )
  );

drop policy if exists "loyalty_transactions_select_super_admin" on public.loyalty_transactions;
create policy "loyalty_transactions_select_super_admin" on public.loyalty_transactions
  for select using (public.is_super_admin());
