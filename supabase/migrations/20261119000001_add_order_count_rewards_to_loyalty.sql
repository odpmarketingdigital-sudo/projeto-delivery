-- ============================================================================
--  Migração: prêmios por quantidade de pedidos no programa de fidelidade
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Complementa a migração 20261118000001 (pontos por real gasto) com um modo
--  de premiação baseado em QUANTIDADE DE PEDIDOS FINALIZADOS cujo prêmio é um
--  produto do cardápio entregue de graça (linha do pedido a R$ 0,00).
--
--  1) `public.loyalty_programs` ganha:
--     - `reward_mode`       → 'points' (padrão, comportamento antigo) ou
--                             'orders' (acumula pedidos finalizados);
--     - `orders_per_reward` → quantos pedidos finalizados valem 1 prêmio;
--     - `reward_product_id` → produto entregue de graça (modo pedidos).
--  2) `public.customer_loyalty` ganha `orders_count` e
--     `free_rewards_available` (prêmios já conquistados e ainda não usados).
--  3) `public.orders` ganha o produto do prêmio e o marcador de pedido já
--     contabilizado (idempotência do contador).
--  4) Funções atômicas novas:
--     - `loyalty_register_order`     → conta o pedido finalizado e libera o
--                                      prêmio quando o ciclo fecha;
--     - `loyalty_revert_order`       → desfaz a contagem no cancelamento e
--                                      devolve o prêmio usado no pedido;
--     - `loyalty_redeem_free_reward` → debita 1 prêmio e grava o produto
--                                      grátis no pedido.
--
--  Regras:
--   - Continua valendo o modelo de pontos quando `reward_mode = 'points'`;
--   - No modo 'orders' o resgate NÃO gera desconto em R$: o servidor injeta
--     a linha do produto do prêmio com preço 0 no pedido;
--   - O painel (`/painel/fidelidade`) grava tudo via `PUT /api/loyalty`;
--   - O checkout só pré-visualiza (`POST /api/loyalty/status`) e a fonte da
--     verdade continua sendo `POST /api/orders` / `PUT /api/orders`.
--
--  Escritas continuam exclusivas das rotas de API via service role
--  (bypass de RLS), mesmo padrão das demais tabelas do projeto.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Configuração: modo de premiação + produto do prêmio
-- ---------------------------------------------------------------------------
alter table public.loyalty_programs
  add column if not exists reward_mode text not null default 'points';
alter table public.loyalty_programs
  add column if not exists orders_per_reward integer not null default 10;
alter table public.loyalty_programs
  add column if not exists reward_product_id uuid;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_reward_product_fk
    foreign key (reward_product_id)
    references public.products (id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_reward_mode_valid
    check (reward_mode in ('points', 'orders'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_orders_per_reward_positive
    check (orders_per_reward >= 1 and orders_per_reward <= 1000);
exception when duplicate_object then null; end $$;

-- O tipo de prêmio aceita agora `free_product` (produto do cardápio grátis).
--
-- ATENÇÃO: a migração 20261118000001 cria a tabela com uma CHECK *inline* na
-- coluna `reward_type`, e o Postgres a nomeia automaticamente como
-- `loyalty_programs_reward_type_check`. Só dropar `..._reward_type_valid`
-- deixava essa constraint antiga ativa e o banco continuava recusando
-- `free_product` (erro: violates check constraint
-- "loyalty_programs_reward_type_check"). As duas precisam sair.
alter table public.loyalty_programs
  drop constraint if exists loyalty_programs_reward_type_check;
alter table public.loyalty_programs
  drop constraint if exists loyalty_programs_reward_type_valid;

do $$
declare
  v_constraint text;
begin
  -- Rede de segurança: remove qualquer outra CHECK de `reward_type` que tenha
  -- ficado com nome fora do padrão (ex.: sufixo `_check1` em bases clonadas).
  for v_constraint in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'loyalty_programs'
       and c.contype = 'c'
       and c.conname like '%reward_type%'
  loop
    execute format(
      'alter table public.loyalty_programs drop constraint if exists %I',
      v_constraint
    );
  end loop;

  alter table public.loyalty_programs
    add constraint loyalty_programs_reward_type_valid
    check (
      reward_type in (
        'fixed_discount',
        'percentage_discount',
        'free_shipping',
        'free_product'
      )
    );
end $$;

-- Modo por pedidos sempre premia com produto grátis, e produto grátis
-- sempre exige um produto configurado (evita programa inconsistente).
do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_orders_mode_free_product
    check (reward_mode <> 'orders' or reward_type = 'free_product');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_free_product_required
    check (reward_type <> 'free_product' or reward_product_id is not null);
exception when duplicate_object then null; end $$;

comment on column public.loyalty_programs.reward_mode is
  'points (acumula pontos por real) ou orders (acumula pedidos finalizados).';
comment on column public.loyalty_programs.orders_per_reward is
  'Quantidade de pedidos finalizados necessária para liberar 1 prêmio (modo orders).';
comment on column public.loyalty_programs.reward_product_id is
  'Produto do cardápio entregue de graça no resgate por pedidos (modo orders).';

-- ---------------------------------------------------------------------------
-- 2) Saldo do cliente: contador de pedidos e prêmios conquistados
-- ---------------------------------------------------------------------------
alter table public.customer_loyalty
  add column if not exists orders_count integer not null default 0;
alter table public.customer_loyalty
  add column if not exists free_rewards_available integer not null default 0;

do $$ begin
  alter table public.customer_loyalty
    add constraint customer_loyalty_orders_count_non_negative
    check (orders_count >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.customer_loyalty
    add constraint customer_loyalty_free_rewards_non_negative
    check (free_rewards_available >= 0);
exception when duplicate_object then null; end $$;

comment on column public.customer_loyalty.orders_count is
  'Pedidos finalizados contabilizados no ciclo atual (modo orders).';
comment on column public.customer_loyalty.free_rewards_available is
  'Prêmios (produtos grátis) já conquistados e ainda não utilizados.';

-- ---------------------------------------------------------------------------
-- 3) Prêmio aplicado no pedido
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists loyalty_reward_product_id uuid;
alter table public.orders
  add column if not exists loyalty_reward_product_name text;
alter table public.orders
  add column if not exists loyalty_order_counted boolean not null default false;

do $$ begin
  alter table public.orders
    add constraint orders_loyalty_reward_product_fk
    foreign key (loyalty_reward_product_id)
    references public.products (id) on delete set null;
exception when duplicate_object then null; end $$;

comment on column public.orders.loyalty_reward_product_id is
  'Produto entregue de graça pelo programa de fidelidade (null = sem prêmio).';
comment on column public.orders.loyalty_reward_product_name is
  'Nome do produto do prêmio congelado no pedido (histórico/relatórios).';
comment on column public.orders.loyalty_order_counted is
  'true quando o pedido já foi contabilizado no contador de pedidos do cliente.';

-- ---------------------------------------------------------------------------
-- 4) Funções atômicas (SECURITY DEFINER: chamadas só com a service role)
-- ---------------------------------------------------------------------------

-- Conta 1 pedido finalizado para o telefone e libera o prêmio quando o ciclo
-- fecha. Idempotente por pedido (`orders.loyalty_order_counted`).
create or replace function public.loyalty_register_order(
  p_establishment_id uuid,
  p_phone text,
  p_customer_name text default null,
  p_order_id uuid default null,
  p_orders_per_reward integer default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone   text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_per     integer := greatest(coalesce(p_orders_per_reward, 10), 1);
  v_counted boolean := false;
  v_count   integer;
  v_free    integer;
  v_balance integer;
  v_rewards integer;
begin
  if p_establishment_id is null or length(v_phone) < 10 then
    return null;
  end if;

  -- O pedido conta uma única vez (reabrir/refinalizar não duplica).
  if p_order_id is not null then
    select coalesce(loyalty_order_counted, false)
      into v_counted
      from public.orders
     where id = p_order_id;

    if coalesce(v_counted, false) then
      select orders_count, free_rewards_available, points_balance, rewards_redeemed
        into v_count, v_free, v_balance, v_rewards
        from public.customer_loyalty
       where establishment_id = p_establishment_id
         and customer_phone = v_phone;

      return jsonb_build_object(
        'orders_count', coalesce(v_count, 0),
        'free_rewards_available', coalesce(v_free, 0),
        'points_balance', coalesce(v_balance, 0),
        'rewards_redeemed', coalesce(v_rewards, 0),
        'reward_unlocked', false,
        'already_counted', true
      );
    end if;
  end if;

  insert into public.customer_loyalty (
    establishment_id, customer_phone, customer_name,
    orders_count, free_rewards_available, last_order_id
  ) values (
    p_establishment_id,
    v_phone,
    nullif(btrim(coalesce(p_customer_name, '')), ''),
    1,
    case when v_per <= 1 then 1 else 0 end,
    p_order_id
  )
  on conflict (establishment_id, customer_phone) do update
     set orders_count = public.customer_loyalty.orders_count + 1,
         free_rewards_available = public.customer_loyalty.free_rewards_available
           + case
               when (public.customer_loyalty.orders_count + 1) % v_per = 0
                 then 1 else 0
             end,
         customer_name = coalesce(
           excluded.customer_name,
           public.customer_loyalty.customer_name
         ),
         last_order_id = coalesce(
           excluded.last_order_id,
           public.customer_loyalty.last_order_id
         ),
         updated_at = now()
  returning orders_count, free_rewards_available, points_balance, rewards_redeemed
    into v_count, v_free, v_balance, v_rewards;

  if p_order_id is not null then
    update public.orders
       set loyalty_order_counted = true
     where id = p_order_id;
  end if;

  return jsonb_build_object(
    'orders_count', v_count,
    'free_rewards_available', v_free,
    'points_balance', v_balance,
    'rewards_redeemed', v_rewards,
    'reward_unlocked', (v_count % v_per = 0),
    'already_counted', false
  );
end;
$$;

revoke all on function public.loyalty_register_order(uuid, text, text, uuid, integer) from public;
grant execute on function public.loyalty_register_order(uuid, text, text, uuid, integer) to service_role;

-- Desfaz a contagem de um pedido cancelado. Devolve também o prêmio que o
-- próprio pedido havia consumido (`free_rewards_available + 1`).
-- Idempotente: um segundo cancelamento não altera nada (retorna `null`).
create or replace function public.loyalty_revert_order(
  p_establishment_id uuid,
  p_phone text,
  p_order_id uuid,
  p_orders_per_reward integer default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone      text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_per        integer := greatest(coalesce(p_orders_per_reward, 10), 1);
  v_counted    boolean := false;
  v_had_reward boolean := false;
  v_count      integer;
  v_free       integer;
  v_rewards    integer;
  v_balance    integer;
begin
  if p_establishment_id is null or p_order_id is null then
    return null;
  end if;
  if length(v_phone) < 10 then
    return null;
  end if;

  select coalesce(loyalty_order_counted, false),
         (loyalty_reward_product_id is not null)
    into v_counted, v_had_reward
    from public.orders
   where id = p_order_id;

  if not coalesce(v_counted, false) then
    return null; -- nada a estornar (já revertido ou pedido nunca contou)
  end if;

  update public.customer_loyalty
     set orders_count = greatest(orders_count - 1, 0),
         free_rewards_available = greatest(
           free_rewards_available
             - case when orders_count % v_per = 0 then 1 else 0 end
             + case when v_had_reward then 1 else 0 end,
           0
         ),
         rewards_redeemed = greatest(
           rewards_redeemed - case when v_had_reward then 1 else 0 end,
           0
         ),
         updated_at = now()
   where establishment_id = p_establishment_id
     and customer_phone = v_phone
  returning orders_count, free_rewards_available, rewards_redeemed, points_balance
    into v_count, v_free, v_rewards, v_balance;

  if v_count is null then
    return null;
  end if;

  update public.orders
     set loyalty_order_counted = false,
         loyalty_reward_product_id = null,
         loyalty_reward_product_name = null
   where id = p_order_id;

  return jsonb_build_object(
    'orders_count', v_count,
    'free_rewards_available', v_free,
    'rewards_redeemed', v_rewards,
    'points_balance', v_balance,
    'reward_returned', v_had_reward
  );
end;
$$;

revoke all on function public.loyalty_revert_order(uuid, text, uuid, integer) from public;
grant execute on function public.loyalty_revert_order(uuid, text, uuid, integer) to service_role;

-- Debita 1 prêmio conquistado e grava no pedido qual produto foi entregue de
-- graça. Devolve `null` quando o cliente não tem prêmio disponível — nesse
-- caso o pedido NÃO pode receber o produto grátis (o chamador remove o pedido).
create or replace function public.loyalty_redeem_free_reward(
  p_establishment_id uuid,
  p_phone text,
  p_order_id uuid,
  p_product_id uuid,
  p_product_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone   text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_count   integer;
  v_free    integer;
  v_rewards integer;
  v_balance integer;
begin
  if p_establishment_id is null or p_order_id is null then
    return null;
  end if;
  if length(v_phone) < 10 then
    return null;
  end if;

  -- Pedido já recebeu o prêmio: devolve o estado atual (idempotente).
  if exists (
    select 1
      from public.orders
     where id = p_order_id
       and loyalty_reward_product_id is not null
  ) then
    select orders_count, free_rewards_available, rewards_redeemed, points_balance
      into v_count, v_free, v_rewards, v_balance
      from public.customer_loyalty
     where establishment_id = p_establishment_id
       and customer_phone = v_phone;

    return jsonb_build_object(
      'free_rewards_available', coalesce(v_free, 0),
      'orders_count', coalesce(v_count, 0),
      'rewards_redeemed', coalesce(v_rewards, 0),
      'points_balance', coalesce(v_balance, 0),
      'already_redeemed', true
    );
  end if;

  update public.customer_loyalty
     set free_rewards_available = free_rewards_available - 1,
         rewards_redeemed = rewards_redeemed + 1,
         updated_at = now()
   where establishment_id = p_establishment_id
     and customer_phone = v_phone
     and free_rewards_available >= 1
  returning orders_count, free_rewards_available, rewards_redeemed, points_balance
    into v_count, v_free, v_rewards, v_balance;

  if v_free is null then
    return null; -- sem prêmio disponível
  end if;

  update public.orders
     set loyalty_reward_product_id = p_product_id,
         loyalty_reward_product_name = nullif(btrim(coalesce(p_product_name, '')), '')
   where id = p_order_id;

  return jsonb_build_object(
    'free_rewards_available', v_free,
    'orders_count', v_count,
    'rewards_redeemed', v_rewards,
    'points_balance', v_balance,
    'already_redeemed', false
  );
end;
$$;

revoke all on function public.loyalty_redeem_free_reward(uuid, text, uuid, uuid, text) from public;
grant execute on function public.loyalty_redeem_free_reward(uuid, text, uuid, uuid, text) to service_role;



