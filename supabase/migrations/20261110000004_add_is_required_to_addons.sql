-- ============================================================================
--  Migração: flag "obrigatório" em public.addons (idempotente)
--  Execute no SQL Editor do Supabase se a tabela `addons` já existir sem a
--  coluna `is_required` (a migração 20261110000003 já a cria em bancos novos).
--
--  `is_required` indica se o adicional/opcional é de escolha obrigatória para
--  o produto (ex: "Escolha o ponto da carne"). Default false = opcional.
-- ============================================================================

alter table public.addons
  add column if not exists is_required boolean not null default false;

comment on column public.addons.is_required is
  'true = escolha obrigatória no produto; false = adicional opcional.';
