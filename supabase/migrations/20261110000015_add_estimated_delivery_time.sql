-- =============================================================================
-- Previsão de entrega (janela em minutos + instante previsto no pedido)
-- =============================================================================
-- Execute no SQL Editor do Supabase (idempotente).
--
-- Campos adicionados em `public.establishments`:
--   estimated_delivery_time_min  tempo mínimo estimado (minutos)
--   estimated_delivery_time_max  tempo máximo estimado (minutos)
--
-- Campos adicionados em `public.orders`:
--   estimated_delivery_time  texto normalizado (ex.: "30-45 min")
--   estimated_delivery_at    instante previsto da entrega (timestamptz)
-- =============================================================================

alter table public.establishments
  add column if not exists estimated_delivery_time_min integer not null default 30,
  add column if not exists estimated_delivery_time_max integer not null default 50;

alter table public.orders
  add column if not exists estimated_delivery_time text,
  add column if not exists estimated_delivery_at timestamptz;

-- Janela válida: entre 1 e 600 minutos e máximo >= mínimo.
do $$
begin
  alter table public.establishments
    add constraint establishments_estimated_delivery_window_valid
    check (
      estimated_delivery_time_min >= 1
      and estimated_delivery_time_max <= 600
      and estimated_delivery_time_max >= estimated_delivery_time_min
    );
exception when duplicate_object then null;
end $$;

comment on column public.establishments.estimated_delivery_time_min is
  'Tempo mínimo estimado de entrega em minutos (padrão 30).';
comment on column public.establishments.estimated_delivery_time_max is
  'Tempo máximo estimado de entrega em minutos (padrão 50).';
comment on column public.orders.estimated_delivery_time is
  'Previsão de entrega normalizada no momento do pedido (ex.: 30-45 min).';
comment on column public.orders.estimated_delivery_at is
  'Instante previsto da entrega, calculado a partir da previsão da loja.';
