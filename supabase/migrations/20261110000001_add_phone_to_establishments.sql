-- ============================================================================
--  Migração: telefone em public.establishments (idempotente)
--  Execute no SQL Editor do Supabase se a tabela já existir sem a coluna
--  `phone` (a migração 20261110000000 já a cria em bancos novos).
-- ============================================================================

alter table public.establishments
  add column if not exists phone text;
