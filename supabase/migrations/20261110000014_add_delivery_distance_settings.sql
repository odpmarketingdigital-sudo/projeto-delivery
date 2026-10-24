-- =============================================================================
-- Entrega por distância (km) + raio máximo de entrega
-- =============================================================================
-- Execute no SQL Editor do Supabase (idempotente).
--
-- Campos adicionados em `public.establishments`:
--   delivery_type            'fixed' (taxa fixa) | 'distance' (por km)
--   distance_base_km         distância inclusa na taxa base (km)
--   distance_base_fee        valor cobrado até `distance_base_km`
--   distance_extra_km_fee    valor por km excedente
--   max_delivery_radius_km   raio máximo (NULL = sem limite)
--   store_cep                CEP da loja (somente dígitos)
--   store_latitude           latitude da loja (origem do cálculo)
--   store_longitude          longitude da loja (origem do cálculo)
--
-- `delivery_fee` (já existente) continua sendo a taxa fixa e também o valor
-- de fallback quando o modelo por distância não consegue calcular a km.
-- =============================================================================

alter table public.establishments
  add column if not exists delivery_type text not null default 'fixed',
  add column if not exists distance_base_km numeric(6, 2) not null default 3,
  add column if not exists distance_base_fee numeric(10, 2) not null default 0,
  add column if not exists distance_extra_km_fee numeric(10, 2) not null default 0,
  add column if not exists max_delivery_radius_km numeric(6, 2),
  add column if not exists store_cep text,
  add column if not exists store_latitude double precision,
  add column if not exists store_longitude double precision;

-- Restringe o modelo de entrega aos dois valores suportados pela aplicação.
do $$
begin
  alter table public.establishments
    add constraint establishments_delivery_type_valid
    check (delivery_type in ('fixed', 'distance'));
exception when duplicate_object then null;
end $$;

-- Valores monetários/distâncias nunca negativos.
do $$
begin
  alter table public.establishments
    add constraint establishments_delivery_values_non_negative
    check (
      delivery_fee >= 0
      and distance_base_km >= 0
      and distance_base_fee >= 0
      and distance_extra_km_fee >= 0
      and (max_delivery_radius_km is null or max_delivery_radius_km > 0)
    );
exception when duplicate_object then null;
end $$;

comment on column public.establishments.delivery_type is
  'Modelo de frete: fixed (taxa fixa) ou distance (base + km excedente).';
comment on column public.establishments.distance_base_km is
  'Distância inclusa na taxa base do modelo por distância (km).';
comment on column public.establishments.distance_base_fee is
  'Valor cobrado até distance_base_km (modelo por distância).';
comment on column public.establishments.distance_extra_km_fee is
  'Valor cobrado por km excedente acima de distance_base_km.';
comment on column public.establishments.max_delivery_radius_km is
  'Raio máximo de entrega em km. NULL = sem limite.';
comment on column public.establishments.store_cep is
  'CEP da loja usado como origem do cálculo de distância (somente dígitos).';
comment on column public.establishments.store_latitude is
  'Latitude da loja (origem do cálculo de distância).';
comment on column public.establishments.store_longitude is
  'Longitude da loja (origem do cálculo de distância).';
