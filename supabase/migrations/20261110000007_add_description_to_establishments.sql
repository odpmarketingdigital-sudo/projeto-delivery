-- ============================================================================
--  Migração: coluna `description` em public.establishments
--  Execute no SQL Editor do Supabase (idempotente / seguro para reexecutar).
--
--  Motivo: a migração 20261110000006 declara esta coluna junto com slug/banner/
--  logo, mas em bases já existentes esse trecho pode não ter sido aplicado. Sem
--  a coluna, a tela de Configurações e o PUT /api/establishment falham com:
--
--    column establishments.description does not exist (SQLSTATE 42703)
--
--  Equivalente mínimo (se preferir colar apenas o comando):
--    alter table public.establishments add column if not exists description text;
-- ============================================================================

alter table public.establishments
  add column if not exists description text;

comment on column public.establishments.description is
  'Texto exibido abaixo do nome no cardápio público (vazio/null → exibe o badge DELIVERY).';
