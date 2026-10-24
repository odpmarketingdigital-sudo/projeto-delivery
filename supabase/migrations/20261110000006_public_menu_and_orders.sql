-- ============================================================================
--  Migração: vitrine pública do cliente + fluxo de pedidos (checkout)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) Colunas públicas em `establishments` (slug, banner, logo, taxa de entrega,
--     WhatsApp, descrição) usadas pela vitrine (/) e pelo checkout (/checkout).
--  2) Políticas de RLS de LEITURA PÚBLICA (somente linhas ativas) — a vitrine
--     é anônima e não tem sessão. A escrita continua exclusiva das rotas de API
--     via service role (mesmo padrão das demais tabelas).
--  3) Tabela `public.orders` (fluxo de pedidos do checkout → POST /api/orders).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Colunas públicas do estabelecimento
-- ---------------------------------------------------------------------------
alter table public.establishments
  add column if not exists slug         text,
  add column if not exists description  text,
  add column if not exists banner_url   text,
  add column if not exists logo_url     text,
  add column if not exists whatsapp     text,
  add column if not exists delivery_fee numeric(10, 2) not null default 5;

comment on column public.establishments.slug is
  'Identificador público amigável usado na URL da vitrine (ex: /?slug=la-fuego).';
comment on column public.establishments.delivery_fee is
  'Taxa de entrega padrão exibida no checkout (subtotal + taxa = total).';
comment on column public.establishments.whatsapp is
  'WhatsApp do estabelecimento para confirmação do pedido.';

-- Slug derivado do nome quando ainda não existe (backfill idempotente).
update public.establishments
set slug = nullif(
      btrim(
        lower(regexp_replace(coalesce(name, ''), '[^a-zA-Z0-9]+', '-', 'g')),
        '-'
      ),
      ''
    )
where slug is null
  and coalesce(name, '') <> '';

-- Índice único parcial (vários nulos são permitidos).
create unique index if not exists establishments_slug_key
  on public.establishments (slug)
  where slug is not null;

-- ---------------------------------------------------------------------------
-- 2) RLS — leitura pública APENAS de estabelecimentos/cardápio ativos
--    (a vitrine é anônima; escrita continua via service role, sem policy).
--    As policies somam-se às existentes (RLS usa OR entre policies).
-- ---------------------------------------------------------------------------
alter table public.establishments enable row level security;

drop policy if exists "establishments_select_public" on public.establishments;
create policy "establishments_select_public"
  on public.establishments
  for select
  using (status = 'ativo');

alter table public.categories enable row level security;
drop policy if exists "categories_select_public" on public.categories;
create policy "categories_select_public"
  on public.categories
  for select
  using (
    is_active
    and exists (
      select 1
      from public.establishments e
      where e.id = categories.establishment_id
        and e.status = 'ativo'
    )
  );

alter table public.products enable row level security;
drop policy if exists "products_select_public" on public.products;
create policy "products_select_public"
  on public.products
  for select
  using (
    is_active
    and exists (
      select 1
      from public.establishments e
      where e.id = products.establishment_id
        and e.status = 'ativo'
    )
  );

alter table public.addons enable row level security;
drop policy if exists "addons_select_public" on public.addons;
create policy "addons_select_public"
  on public.addons
  for select
  using (
    is_active
    and exists (
      select 1
      from public.establishments e
      where e.id = addons.establishment_id
        and e.status = 'ativo'
    )
  );

-- ---------------------------------------------------------------------------
-- 3) Tabela `orders` (pedidos do checkout)
--    Idempotente: cria se não existir e completa colunas ausentes caso a base
--    já tenha uma versão anterior com schema parcial.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null
                     references public.establishments (id) on delete cascade,
  customer_id      uuid references auth.users (id) on delete set null,
  customer_name    text not null default '',
  customer_phone   text,
  customer_address jsonb not null default '{}'::jsonb,
  items            jsonb not null default '[]'::jsonb,
  subtotal         numeric(10, 2) not null default 0,
  delivery_fee     numeric(10, 2) not null default 0,
  total            numeric(10, 2) not null default 0,
  payment_method   text not null default 'dinheiro',
  change_for       numeric(10, 2),
  notes            text,
  status           text not null default 'pendente',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Complementa uma eventual versão pré-existente (equivalente a if not exists).
alter table public.orders add column if not exists establishment_id uuid;
alter table public.orders add column if not exists customer_id      uuid;
alter table public.orders add column if not exists customer_name    text not null default '';
alter table public.orders add column if not exists customer_phone   text;
alter table public.orders add column if not exists customer_address jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists items            jsonb not null default '[]'::jsonb;
alter table public.orders add column if not exists subtotal         numeric(10, 2) not null default 0;
alter table public.orders add column if not exists delivery_fee     numeric(10, 2) not null default 0;
alter table public.orders add column if not exists total            numeric(10, 2) not null default 0;
alter table public.orders add column if not exists payment_method   text not null default 'dinheiro';
alter table public.orders add column if not exists change_for       numeric(10, 2);
alter table public.orders add column if not exists notes            text;
alter table public.orders add column if not exists status           text not null default 'pendente';
alter table public.orders add column if not exists created_at       timestamptz not null default now();
alter table public.orders add column if not exists updated_at       timestamptz not null default now();

create index if not exists orders_establishment_idx
  on public.orders (establishment_id);
create index if not exists orders_status_idx
  on public.orders (status);
create index if not exists orders_created_at_idx
  on public.orders (created_at desc);

-- Mantém updated_at atualizado (reusa a função set_updated_at do schema.sql).
drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- RLS: dono do estabelecimento e super admin leem os próprios pedidos.
-- Escrita: exclusivamente via API (service role, bypass de RLS) — o checkout
-- é anônimo, por isso NÃO existe policy de insert para clientes.
alter table public.orders enable row level security;

drop policy if exists "orders_select_owner" on public.orders;
create policy "orders_select_owner"
  on public.orders
  for select
  using (
    exists (
      select 1
      from public.establishments e
      where e.id = orders.establishment_id
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "orders_select_super_admin" on public.orders;
create policy "orders_select_super_admin"
  on public.orders
  for select
  using (public.is_super_admin());

