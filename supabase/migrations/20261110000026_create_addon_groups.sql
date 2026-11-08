-- ============================================================================
--  Migração: grupos de opcionais (opções) dos produtos do cardápio
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Estilo Menudino / iFood: cada produto pode ter vários GRUPOS de opcionais
--  (ex.: "Escolha o tipo de carne", "Escolha 3 acompanhamentos"). Cada grupo
--  define regras de seleção (obrigatório?, mínimo e máximo de escolhas) e
--  agrupa os seus itens (os itens continuam em public.addons, agora ligados a
--  um grupo via `group_id`).
--
--    - public.addon_groups → grupos de opcionais de um produto
--    - public.addons       → itens/opções que pertencem a um grupo (group_id)
--
--  Regras de acesso (RLS) — idênticas a categories/products/addons:
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
-- 1) Grupos de opcionais
--    - product_id/establishment_id usam ON DELETE CASCADE: excluir o produto
--      (ou a loja) apaga os seus grupos.
--    - min_selectors/max_selectors definem a regra de seleção do grupo.
--    - is_required marca o grupo como obrigatório na vitrine.
-- ---------------------------------------------------------------------------
create table if not exists public.addon_groups (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  product_id       uuid not null
                     references public.products (id) on delete cascade,
  name             text not null,
  description      text not null default '',
  is_required      boolean not null default false,
  min_selectors    integer not null default 0,
  max_selectors    integer not null default 1,
  is_active        boolean not null default true,
  position         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint addon_groups_min_check check (min_selectors >= 0),
  constraint addon_groups_max_check check (max_selectors >= 1),
  constraint addon_groups_min_le_max check (min_selectors <= max_selectors)
);

comment on table public.addon_groups is
  'Grupos de opcionais de um produto (ex.: "Escolha 3 acompanhamentos").';

comment on column public.addon_groups.description is
  'Instrução exibida ao cliente (ex.: "Escolha entre 1 e 3 opções").';

comment on column public.addon_groups.is_required is
  'true = grupo de seleção obrigatória; false = opcional.';

comment on column public.addon_groups.min_selectors is
  'Mínimo de itens que o cliente deve escolher no grupo.';

comment on column public.addon_groups.max_selectors is
  'Máximo de itens que o cliente pode escolher no grupo.';

create index if not exists addon_groups_establishment_idx
  on public.addon_groups (establishment_id);

create index if not exists addon_groups_product_idx
  on public.addon_groups (product_id);

drop trigger if exists addon_groups_set_updated_at on public.addon_groups;
create trigger addon_groups_set_updated_at
  before update on public.addon_groups
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Liga cada adicional (opção) a um grupo.
--    ON DELETE SET NULL: ao excluir o grupo, os itens viram "sem grupo"
--    (não são apagados, preservando histórico/edição).
-- ---------------------------------------------------------------------------
alter table public.addons
  add column if not exists group_id uuid
    references public.addon_groups (id) on delete set null;

comment on column public.addons.group_id is
  'Grupo de opcionais ao qual o item pertence (null = sem grupo).';

create index if not exists addons_group_idx
  on public.addons (group_id);

-- ---------------------------------------------------------------------------
-- 3) RLS — grupos de opcionais
-- ---------------------------------------------------------------------------
alter table public.addon_groups enable row level security;

drop policy if exists "addon_groups_select_owner" on public.addon_groups;
create policy "addon_groups_select_owner"
  on public.addon_groups
  for select
  using (
    exists (
      select 1
      from public.establishments e
      where e.id = addon_groups.establishment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "addon_groups_select_super_admin" on public.addon_groups;
create policy "addon_groups_select_super_admin"
  on public.addon_groups
  for select
  using (public.is_super_admin());
