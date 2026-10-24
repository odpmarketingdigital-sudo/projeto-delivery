-- ============================================================================
--  Migração: tabela public.establishments (Gestão de Estabelecimentos)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Cada estabelecimento tem 1 conta de acesso em auth.users (role admin).
--  A tabela guarda os dados da loja e referencia o usuário dono (user_id).
-- ============================================================================

create table if not exists public.establishments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique
                references auth.users (id) on delete cascade,
  name        text not null,
  owner_name  text not null,
  email       text not null,
  phone       text,
  status      text not null default 'ativo'
                check (status in ('ativo', 'inativo')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.establishments is
  'Estabelecimentos (lojas) da plataforma. Cada linha tem um user_id em auth.users.';

create index if not exists establishments_status_idx
  on public.establishments (status);

-- Mantém updated_at atualizado (reusa a função set_updated_at do schema.sql).
drop trigger if exists establishments_set_updated_at on public.establishments;
create trigger establishments_set_updated_at
  before update on public.establishments
  for each row execute function public.set_updated_at();

-- RLS: dono lê o próprio estabelecimento; super admin lê todos.
-- As escritas (insert/update/delete) são feitas pelas rotas de API via
-- service role key (bypass de RLS) — não há policy de escrita para clientes.
alter table public.establishments enable row level security;

drop policy if exists "establishments_select_own" on public.establishments;
create policy "establishments_select_own"
  on public.establishments
  for select
  using (auth.uid() = user_id);

drop policy if exists "establishments_select_super_admin" on public.establishments;
create policy "establishments_select_super_admin"
  on public.establishments
  for select
  using (public.is_super_admin());
