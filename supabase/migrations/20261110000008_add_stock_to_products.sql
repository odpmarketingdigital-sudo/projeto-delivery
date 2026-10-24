-- ============================================================================
--  Migração: controle de estoque em public.products (idempotente)
--  Execute no SQL Editor do Supabase (seguro para reexecutar).
--
--  Colunas:
--    - track_stock    → true = o produto controla estoque limitado;
--                       false = estoque ilimitado (sempre disponível).
--    - stock_quantity → quantidade disponível quando track_stock = true;
--                       ao chegar em 0 o produto aparece "Esgotado" na vitrine.
--
--  Sem essas colunas, POST/PUT /api/products falham ao salvar o controle de
--  estoque ("column products.track_stock does not exist").
-- ============================================================================

alter table public.products
  add column if not exists track_stock boolean not null default false,
  add column if not exists stock_quantity integer not null default 0;

-- Garante a constraint de não-negatividade mesmo em bases onde a coluna já
-- existia sem a validação.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_stock_quantity_non_negative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_stock_quantity_non_negative
      check (stock_quantity >= 0);
  end if;
end;
$$;

comment on column public.products.track_stock is
  'true = controla estoque limitado em stock_quantity; false = estoque ilimitado.';

comment on column public.products.stock_quantity is
  'Quantidade disponível quando track_stock = true. 0 = esgotado na vitrine.';
