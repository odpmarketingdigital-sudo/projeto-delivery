-- ============================================================================
--  Migração: adicionais (opcionais) dos produtos do cardápio
--  Execute no SQL Editor do Supabase (idempotente).
--
--  A tabela public.addons guarda opcionais/adicionais de um produto
--  (ex: "Bacon +R$ 5,00", "Sem cebola"), sempre vinculados a:
--    - public.products   (product_id)   → o optional pertence a um item
--    - public.establishments (establishment_id) → escopo do estabelecimento
--
--  Regras de acesso (RLS) — idênticas a categories/products:
--    - Leitura: o dono do estabelecimento e o super admin.
--    - Escrita: EXCLUSIVAMENTE via rotas de API (service role key), que fazem
--      bypass de RLS. Não há policy de insert/update/delete para clientes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0) Função de updated_at (idempotente; espelha a de supabase/schema.sql).
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1) Adicionais
--    - product_id usa ON DELETE CASCADE: excluir um produto apaga os seus
--      adicionais (nada fica órfão).
--    - price é numeric(10,2) (precisão monetária) e nunca negativo.
-- ---------------------------------------------------------------------------
create table if not exists public.addons (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  product_id       uuid not null
                     references public.products (id) on delete cascade,
  name             text not null,
  price            numeric(10, 2) not null default 0 check (price >= 0),
  is_required      boolean not null default false,
  is_active        boolean not null default true,
  position         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.addons is
  'Adicionais/opcionais de um produto do cardápio (product_id + establishment_id).';

create index if not exists addons_establishment_idx
  on public.addons (establishment_id);

create index if not exists addons_product_idx
  on public.addons (product_id);

drop trigger if exists addons_set_updated_at on public.addons;
create trigger addons_set_updated_at
  before update on public.addons
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) RLS — adicionais
-- ---------------------------------------------------------------------------
alter table public.addons enable row level security;

drop policy if exists "addons_select_owner" on public.addons;
create policy "addons_select_owner"
  on public.addons
  for select
  using (
    exists (
      select 1
      from public.establishments e
      where e.id = addons.establishment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "addons_select_super_admin" on public.addons;
create policy "addons_select_super_admin"
  on public.addons
  for select
  using (public.is_super_admin());
