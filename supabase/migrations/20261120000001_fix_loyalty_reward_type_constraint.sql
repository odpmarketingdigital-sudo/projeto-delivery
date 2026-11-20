-- ============================================================================
--  Migração: corrige a CHECK de `loyalty_programs.reward_type`
--  Execute no SQL Editor do Supabase (idempotente).
--
--  PROBLEMA
--  A migração 20261118000001 cria `public.loyalty_programs` com uma CHECK
--  *inline* na coluna `reward_type`:
--
--      reward_type text not null default 'fixed_discount'
--        check (reward_type in ('fixed_discount', 'percentage_discount', 'free_shipping')),
--
--  Como a constraint não foi nomeada, o Postgres a batiza de
--  `loyalty_programs_reward_type_check`. A migração 20261119000001 (prêmio por
--  quantidade de pedidos) só removia `loyalty_programs_reward_type_valid`,
--  deixando a constraint auto-nomeada no lugar. Resultado: ao salvar
--  `reward_type = 'free_product'` (produto grátis) vindo de `PUT /api/loyalty`,
--  o banco recusa com:
--
--      new row for relation "loyalty_programs" violates check constraint
--      "loyalty_programs_reward_type_check"
--
--  CORREÇÃO
--  1) remove a constraint auto-nomeada e a nomeada (e qualquer variação);
--  2) recria uma única CHECK nomeada aceitando todos os valores válidos:
--     fixed_discount | percentage_discount | free_shipping | free_product.
--
--  Nenhum dado é alterado. Depois desta migração o painel
--  (`/painel/fidelidade` → `PUT /api/loyalty`) passa a salvar tanto o modo por
--  pontos quanto o modo por pedidos com produto grátis.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Remove as constraints antigas (nome explícito do erro + nome histórico)
-- ---------------------------------------------------------------------------
alter table public.loyalty_programs
  drop constraint if exists loyalty_programs_reward_type_check;

alter table public.loyalty_programs
  drop constraint if exists loyalty_programs_reward_type_valid;

-- ---------------------------------------------------------------------------
-- 2) Rede de segurança: remove qualquer outra CHECK de `reward_type`
--    (ex.: bases clonadas em que o Postgres sufixou o nome com `_check1`)
-- ---------------------------------------------------------------------------
do $$
declare
  v_constraint text;
begin
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
end $$;

-- ---------------------------------------------------------------------------
-- 3) Recria a CHECK com todos os valores aceitos pelo backend
--    (`LOYALTY_REWARD_TYPES` em `lib/loyalty.ts`)
-- ---------------------------------------------------------------------------
do $$ begin
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
exception when duplicate_object then null; end $$;

comment on column public.loyalty_programs.reward_type is
  'fixed_discount (R$), percentage_discount (%), free_shipping (frete grátis) ou free_product (produto do cardápio grátis).';

-- ---------------------------------------------------------------------------
-- 4) Conferência (opcional): deve listar apenas `loyalty_programs_reward_type_valid`
--    (e as demais CHECKs de negócio, que não restringem o tipo de prêmio).
-- ---------------------------------------------------------------------------
-- select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where conrelid = 'public.loyalty_programs'::regclass
--    and contype = 'c'
--  order by conname;
