-- ============================================================================
--  Migração: múltiplos produtos e quantidade no prêmio de produto grátis
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Complementa as migrações 20261118000001 e 20261119000001 permitindo que o
--  lojista configure VÁRIOS produtos elegíveis e quantos itens o cliente ganha
--  por prêmio (ex.: "Complete 10 pedidos e escolha 2 produtos grátis").
--
--  1) `public.loyalty_programs` ganha:
--     - `reward_product_ids`      → uuid[] com os produtos elegíveis (o cliente
--                                   escolhe entre eles na hora do resgate);
--     - `reward_product_quantity` → quantos itens grátis por prêmio (1 a 10).
--     A coluna antiga `reward_product_id` continua existindo e espelha o
--     primeiro item da lista (compatibilidade com painéis/consultas antigas).
--  2) `public.orders` ganha `loyalty_reward_product_ids uuid[]` com os produtos
--     efetivamente entregues no resgate (o campo singular continua preenchido).
--  3) `loyalty_redeem_free_reward` passa a aceitar a lista de produtos e grava
--     todos no pedido; `loyalty_revert_order` limpa a lista no cancelamento.
--
--  Regras preservadas:
--   - 1 prêmio continua pagando 1 resgate (o débito é sempre de 1 recompensa,
--     não importa quantos itens o prêmio entregue);
--   - nada é apagado: lojas com 1 produto são migradas para uma lista com 1
--     item automaticamente;
--   - escritas seguem exclusivas das rotas de API via service role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Configuração: lista de produtos elegíveis + quantidade por prêmio
-- ---------------------------------------------------------------------------
alter table public.loyalty_programs
  add column if not exists reward_product_ids uuid[];
alter table public.loyalty_programs
  add column if not exists reward_product_quantity integer not null default 1;

-- Backfill: loja antiga com 1 produto → lista com esse produto.
update public.loyalty_programs
   set reward_product_ids = array[reward_product_id]
 where reward_product_id is not null
   and coalesce(cardinality(reward_product_ids), 0) = 0;

-- Backfill inverso: lista preenchida manualmente → espelha o 1º item no campo
-- legado (a CHECK antiga e telas antigas continuam funcionando).
update public.loyalty_programs
   set reward_product_id = reward_product_ids[1]
 where reward_product_id is null
   and coalesce(cardinality(reward_product_ids), 0) > 0;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_reward_product_quantity_valid
    check (reward_product_quantity >= 1 and reward_product_quantity <= 10);
exception when duplicate_object then null; end $$;

-- A obrigatoriedade do produto passa a aceitar a lista (mantendo o campo
-- singular para bases/painéis antigos).
alter table public.loyalty_programs
  drop constraint if exists loyalty_programs_free_product_required;

do $$ begin
  alter table public.loyalty_programs
    add constraint loyalty_programs_free_product_required
    check (
      reward_type <> 'free_product'
      or coalesce(cardinality(reward_product_ids), 0) > 0
      or reward_product_id is not null
    );
exception when duplicate_object then null; end $$;

comment on column public.loyalty_programs.reward_product_ids is
  'Produtos elegíveis ao prêmio de produto grátis (o cliente escolhe no resgate).';
comment on column public.loyalty_programs.reward_product_quantity is
  'Quantos itens grátis o cliente ganha ao resgatar 1 prêmio (1 a 10).';
comment on column public.loyalty_programs.reward_product_id is
  'Primeiro produto de reward_product_ids (compatibilidade com versões antigas).';

-- ---------------------------------------------------------------------------
-- 2) Pedido: lista de produtos entregues no resgate
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists loyalty_reward_product_ids uuid[];

update public.orders
   set loyalty_reward_product_ids = array[loyalty_reward_product_id]
 where loyalty_reward_product_id is not null
   and coalesce(cardinality(loyalty_reward_product_ids), 0) = 0;

comment on column public.orders.loyalty_reward_product_ids is
  'Produtos entregues de graça pelo programa de fidelidade (1 item por unidade do prêmio).';

-- ---------------------------------------------------------------------------
-- 3) Funções atômicas (SECURITY DEFINER: chamadas só com a service role)
-- ---------------------------------------------------------------------------

-- Estorno do cancelamento: além de desfazer a contagem, devolve o prêmio que o
-- pedido havia consumido e limpa a lista de produtos entregues.
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
         (
           loyalty_reward_product_id is not null
           or coalesce(cardinality(loyalty_reward_product_ids), 0) > 0
         )
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
         loyalty_reward_product_ids = null,
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

-- Debita 1 prêmio conquistado e grava no pedido TODOS os produtos entregues de
-- graça. Devolve `null` quando o cliente não tem prêmio disponível — nesse caso
-- o pedido NÃO pode receber os produtos grátis (o chamador remove o pedido).
--
-- A assinatura antiga (5 argumentos) é substituída por esta (com defaults nos
-- novos parâmetros), então chamadas antigas continuam funcionando: quando
-- `p_product_ids` não é informado usamos `p_product_id`.
drop function if exists public.loyalty_redeem_free_reward(uuid, text, uuid, uuid, text);

create or replace function public.loyalty_redeem_free_reward(
  p_establishment_id uuid,
  p_phone text,
  p_order_id uuid,
  p_product_id uuid,
  p_product_name text default null,
  p_product_ids uuid[] default null,
  p_product_names text[] default null,
  p_quantity integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone    text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_quantity integer := greatest(coalesce(p_quantity, 1), 1);
  v_ids      uuid[];
  v_names    text[];
  v_name     text;
  v_count    integer;
  v_free     integer;
  v_rewards  integer;
  v_balance  integer;
begin
  if p_establishment_id is null or p_order_id is null then
    return null;
  end if;
  if length(v_phone) < 10 then
    return null;
  end if;

  -- Lista de produtos (nova assinatura) com fallback para o produto único.
  if coalesce(cardinality(p_product_ids), 0) > 0 then
    v_ids := p_product_ids;
  elsif p_product_id is not null then
    v_ids := array[p_product_id];
  else
    return null;
  end if;

  if coalesce(cardinality(p_product_names), 0) > 0 then
    v_names := p_product_names;
  elsif nullif(btrim(coalesce(p_product_name, '')), '') is not null then
    v_names := array[p_product_name];
  else
    v_names := '{}'::text[];
  end if;

  v_name := array_to_string(v_names, ', ');

  -- Pedido já recebeu o prêmio: devolve o estado atual (idempotente).
  if exists (
    select 1
      from public.orders
     where id = p_order_id
       and (
         loyalty_reward_product_id is not null
         or coalesce(cardinality(loyalty_reward_product_ids), 0) > 0
       )
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

  -- O débito é sempre de 1 recompensa, independentemente da quantidade de
  -- itens que o prêmio entrega.
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
     set loyalty_reward_product_id = v_ids[1],
         loyalty_reward_product_ids = v_ids,
         loyalty_reward_product_name = nullif(btrim(coalesce(v_name, '')), '')
   where id = p_order_id;

  return jsonb_build_object(
    'free_rewards_available', v_free,
    'orders_count', v_count,
    'rewards_redeemed', v_rewards,
    'points_balance', v_balance,
    'already_redeemed', false,
    'reward_product_ids', to_jsonb(v_ids),
    'reward_product_quantity', v_quantity
  );
end;
$$;

revoke all on function public.loyalty_redeem_free_reward(uuid, text, uuid, uuid, text, uuid[], text[], integer) from public;
grant execute on function public.loyalty_redeem_free_reward(uuid, text, uuid, uuid, text, uuid[], text[], integer) to service_role;


