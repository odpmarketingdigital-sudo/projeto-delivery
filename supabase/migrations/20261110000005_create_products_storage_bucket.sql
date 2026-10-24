-- ============================================================================
--  Migração: bucket de storage para as imagens dos produtos
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Cria o bucket público `products`, usado pelo painel (/painel/produtos) para
--  fazer upload das fotos dos itens do cardápio. A URL pública gerada é salva
--  na coluna `products.image_url`.
--
--  Organização dos arquivos (paths) e regras de acesso (RLS em storage.objects):
--    - Path: `<establishment_id>/<uuid>.<ext>` (o 1º folder é o estabelecimento).
--    - Insert/Update/Delete: o dono do estabelecimento (auth.uid() = user_id) ou
--      o super admin — apenas dentro do próprio prefixo.
--    - Select: público (bucket público), para as imagens aparecerem no cardápio.
--
--  Reutiliza `public.is_super_admin()` definida em supabase/schema.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Bucket público (idempotente)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('products', 'products', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2) RLS — storage.objects
-- ---------------------------------------------------------------------------

-- Leitura pública (bucket público): qualquer pessoa pode ver as imagens.
drop policy if exists "products_storage_select_public" on storage.objects;
create policy "products_storage_select_public"
  on storage.objects
  for select
  using (bucket_id = 'products');

-- Upload/atualização/exclusão pelo dono do estabelecimento (escopo pelo 1º folder).
drop policy if exists "products_storage_insert_owner" on storage.objects;
create policy "products_storage_insert_owner"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'products'
    and exists (
      select 1
      from public.establishments e
      where e.id::text = (storage.foldername(name))[1]
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "products_storage_update_owner" on storage.objects;
create policy "products_storage_update_owner"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'products'
    and exists (
      select 1
      from public.establishments e
      where e.id::text = (storage.foldername(name))[1]
        and e.user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'products'
    and exists (
      select 1
      from public.establishments e
      where e.id::text = (storage.foldername(name))[1]
        and e.user_id = auth.uid()
    )
  );

drop policy if exists "products_storage_delete_owner" on storage.objects;
create policy "products_storage_delete_owner"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'products'
    and exists (
      select 1
      from public.establishments e
      where e.id::text = (storage.foldername(name))[1]
        and e.user_id = auth.uid()
    )
  );

-- Super admin pode gerenciar qualquer imagem do bucket.
drop policy if exists "products_storage_write_super_admin" on storage.objects;
create policy "products_storage_write_super_admin"
  on storage.objects
  for all
  to authenticated
  using (bucket_id = 'products' and public.is_super_admin())
  with check (bucket_id = 'products' and public.is_super_admin());
