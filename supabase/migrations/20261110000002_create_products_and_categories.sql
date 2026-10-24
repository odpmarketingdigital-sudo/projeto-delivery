-- ============================================================================
--  Migração: categorias e produtos do cardápio (por estabelecimento)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Cada estabelecimento (public.establishments) gerencia o seu próprio cardápio:
--    - public.categories → categorias (ex: "Lanches", "Bebidas", "Sobremesas")
--    - public.products   → itens do cardápio, vinculados a uma categoria
--
--  Regras de acesso (RLS):
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
-- 1) Categorias
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  name             text not null,
  position         integer not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.categories is
  'Categorias do cardápio de um estabelecimento (ordenação via position).';

create index if not exists categories_establishment_idx
  on public.categories (establishment_id);

drop trigger if exists categories_set_updated_at on public.categories;
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Produtos
--    - category_id usa ON DELETE SET NULL: remover uma categoria não apaga os
--      produtos, apenas os deixa "sem categoria".
--    - price é numeric(10,2) (precisão monetária) e nunca negativo.
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  category_id      uuid
                     references public.categories (id) on delete set null,
  name             text not null,
  description      text not null default '',
  price            numeric(10, 2) not null default 0 check (price >= 0),
  image_url        text not null default '',
  is_active        boolean not null default true,
  position         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.products is
  'Produtos do cardápio de um estabelecimento. is_active = false pausa o item.';

create index if not exists products_establishment_idx
  on public.products (establishment_id);

create index if not exists products_category_idx
  on public.products (category_id);

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) RLS — categorias
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;

drop policy if exists "categories_select_owner" on public.categories;
create policy "categories_select_owner"
  on public.categories
  for select
  using (
    exists (
      select 1
      from public.establishments e
      where e.id = categories.establishment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "categories_select_super_admin" on public.categories;
create policy "categories_select_super_admin"
  on public.categories
  for select
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 4) RLS — produtos
-- ---------------------------------------------------------------------------
alter table public.products enable row level security;

drop policy if exists "products_select_owner" on public.products;
create policy "products_select_owner"
  on public.products
  for select
  using (
    exists (
      select 1
      from public.establishments e
      where e.id = products.establishment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "products_select_super_admin" on public.products;
create policy "products_select_super_admin"
  on public.products
  for select
  using (public.is_super_admin());
