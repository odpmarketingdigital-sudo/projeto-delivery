-- ============================================================================
--  Supabase — Schema de autenticação e perfis (RBAC)
--  Projeto: projeto-delivery (Painel do Restaurante)
-- ============================================================================
--  Execute este script no SQL Editor do Supabase (Dashboard → SQL → New query).
--
--  O sistema de autenticação depende de uma tabela pública `profiles` com o
--  mesmo `id` do usuário em `auth.users`. O papel (role) é a fonte da verdade
--  para o controle de acesso:
--    - super_admin → acesso total (/painel/admin)
--    - admin       → estabelecimento (/painel)
--    - cliente     → não acessa o painel
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Tabela de perfis
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  name          text not null default '',
  email         text not null default '',
  role          text not null default 'cliente'
                  check (role in ('super_admin', 'admin', 'cliente')),
  establishment text not null default '',
  status        text not null default 'ativo'
                  check (status in ('ativo', 'inativo')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  'Perfis de usuários (1:1 com auth.users). Define o papel/RBAC do painel.';

-- Índice por papel (usado nas políticas de leitura do super admin).
create index if not exists profiles_role_idx on public.profiles (role);

-- ---------------------------------------------------------------------------
-- 2) Trigger: cria o perfil automaticamente ao cadastrar um usuário em auth.
--    Lê os metadados enviados em `user_metadata` (name, establishment, role).
--    Assim a rota /api/admin/create-user (service role) e o signup normal
--    geram a linha em `profiles` sem passo extra.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role, establishment)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'role', 'cliente'),
    coalesce(new.raw_user_meta_data ->> 'establishment', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Recria o trigger de forma idempotente.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3) Trigger: mantém updated_at atualizado.
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

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) Row Level Security (RLS)
--    - Cada usuário lê e atualiza o próprio perfil.
--    - O super admin pode ler todos os perfis (para a gestão de usuários).
--    - A rota de API usa a service role key, que ignora RLS (bypass).
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Leitura do próprio perfil.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  using (auth.uid() = id);

-- Atualização do próprio perfil (o usuário não altera o próprio role/status
-- livremente — a policy de update cobre apenas dados de exibição; para elevar
-- privilégios use a service role key no servidor).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Super admin lê todos os perfis. Evita recursão em RLS usando uma função
-- security definer que consulta o papel do usuário atual.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'super_admin'
  );
$$;

drop policy if exists "profiles_select_super_admin" on public.profiles;
create policy "profiles_select_super_admin"
  on public.profiles
  for select
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 5) Primeiro Super Admin (bootstrap)
--    Depois de criar o usuário em Authentication → Users, rode:
--      update public.profiles
--      set role = 'super_admin'
--      where email = 'seu-email@exemplo.com';
--    (O trigger já cria a linha; este UPDATE apenas eleva o papel.)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6) Tabela de estabelecimentos (Gestão no painel /painel/admin)
--    Cada estabelecimento tem 1 conta de acesso em auth.users (role admin).
--    A tabela guarda os dados da loja e referencia o usuário dono (user_id).
--    As escritas são feitas pelas rotas de API via service role key.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6.1) phone em establishments (idempotente)
--     Para bancos cuja tabela já foi criada antes de phone existir.
-- ---------------------------------------------------------------------------
alter table public.establishments
  add column if not exists phone text;

create index if not exists establishments_status_idx
  on public.establishments (status);

drop trigger if exists establishments_set_updated_at on public.establishments;
create trigger establishments_set_updated_at
  before update on public.establishments
  for each row execute function public.set_updated_at();

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
