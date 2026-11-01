-- ============================================================================
-- Habilita o Supabase Realtime na tabela `public.orders`.
--
-- O Kanban do painel (/painel) assina `postgres_changes` em `orders` filtrando
-- por `establishment_id`; para os eventos chegarem é preciso:
--   1) a tabela estar na publicação `supabase_realtime`;
--   2) `REPLICA IDENTITY FULL`, pois o filtro é por uma coluna que não é a PK
--      (sem isso o UPDATE chega só com as colunas alteradas + id e o filtro
--      por `establishment_id` não casa);
--   3) o assinante ter SELECT via RLS — `orders_select_owner` (dono) e
--      `orders_select_super_admin` cobrem o painel.
--
-- O acompanhamento público (/pedido/[id]) é anônimo e NÃO tem policy de
-- SELECT em `orders`: ele continua atualizando pelo polling de 10s do
-- `PedidoTracker` (nenhum dado é exposto por Realtime).
--
-- Idempotente: pode ser aplicada mais de uma vez (SQL Editor / `db push`).
-- ============================================================================

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end
$$;

-- Payload completo nos UPDATEs (necessário para filtros por colunas não-PK).
alter table public.orders replica identity full;
