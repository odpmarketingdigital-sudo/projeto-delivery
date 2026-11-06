-- =============================================================================
-- Modo Catálogo: liberação exclusiva do Super Admin
-- =============================================================================
-- Execute no SQL Editor do Supabase (idempotente).
--
-- Campo adicionado em `public.establishments`:
--   catalog_mode_allowed  quando true, o Super Admin liberou a loja para usar o
--                        "Modo catálogo" (pedido/orçamento direto no WhatsApp,
--                        coluna `direct_whatsapp_checkout`). Quando false, a
--                        chave aparece bloqueada no painel da loja e o cardápio
--                        público ignora `direct_whatsapp_checkout` (fluxo de
--                        checkout tradicional).
--
-- Default `false`: nenhuma loja existente ganha o recurso automaticamente — a
-- liberação é concedida loja a loja em /painel/admin.
--
-- RLS:
--   - leitura: políticas já existentes (`establishments_select_own` e
--     `establishments_select_super_admin`);
--   - escrita: SOMENTE o Super Admin pode atualizar a coluna diretamente pelo
--     cliente autenticado (policy abaixo + privilégio de coluna). O lojista
--     continua sem conseguir mexer no próprio registro: as demais colunas
--     seguem sendo gravadas apenas pelas rotas de API (service role key).
-- =============================================================================

alter table public.establishments
  add column if not exists catalog_mode_allowed boolean not null default false;

comment on column public.establishments.catalog_mode_allowed is
  'Liberação do Modo catálogo (pedido direto no WhatsApp) controlada exclusivamente pelo Super Admin (padrão false).';

-- Índice parcial: consultas do painel do Super Admin sobre lojas liberadas.
create index if not exists establishments_catalog_mode_allowed_idx
  on public.establishments (catalog_mode_allowed)
  where catalog_mode_allowed;

-- ---------------------------------------------------------------------------
-- 1) RLS: Super Admin atualiza qualquer estabelecimento.
-- ---------------------------------------------------------------------------
drop policy if exists "establishments_update_catalog_mode_super_admin"
  on public.establishments;
create policy "establishments_update_catalog_mode_super_admin"
  on public.establishments
  for update
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 2) Privilégio de coluna: a sessão do Super Admin só altera
--    `catalog_mode_allowed`. Sem o GRANT de UPDATE na tabela inteira, nada mais
--    é gravável pelo cliente (as rotas de API usam service role e não são
--    afetadas por este revoke).
-- ---------------------------------------------------------------------------
revoke update on public.establishments from anon, authenticated;
grant update (catalog_mode_allowed) on public.establishments to authenticated;
