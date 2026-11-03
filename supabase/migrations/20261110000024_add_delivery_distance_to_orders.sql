-- ============================================================================
--  Migração: distância e tempo de rota no pedido (Google Routes API)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Por que:
--    A taxa de entrega do modelo "por distância" deixou de usar a distância em
--    linha reta (Haversine) e passou a usar a rota real de carro devolvida pela
--    Google Routes API (`computeRoutes`). Para auditar o valor cobrado — e
--    reembolsar/ajustar com segurança — o pedido guarda a distância, o tempo de
--    percurso e a origem do cálculo.
--
--  Colunas novas em `public.orders`:
--    delivery_distance_km       → distância da rota em km (ex.: 3.42);
--                                 null em lojas de taxa fixa sem raio
--    delivery_duration_minutes  → tempo estimado de percurso em minutos
--                                 (null no fallback em linha reta)
--    delivery_distance_source   → 'google_routes' (rota real + trânsito) ou
--                                 'haversine' (linha reta, sem chave/erro)
--
--  Compatibilidade: todas as colunas são anuláveis e a rota `POST /api/orders`
--  detecta a ausência delas, regravando o pedido sem esses campos (o pedido e
--  a taxa continuam funcionando antes desta migração).
-- ============================================================================

alter table public.orders
  add column if not exists delivery_distance_km numeric(6,2),
  add column if not exists delivery_duration_minutes integer,
  add column if not exists delivery_distance_source text;

comment on column public.orders.delivery_distance_km is
  'Distância da rota usada no cálculo da taxa de entrega (km).';

comment on column public.orders.delivery_duration_minutes is
  'Tempo estimado de percurso em minutos (Google Routes API).';

comment on column public.orders.delivery_distance_source is
  'Origem da distância: google_routes (rota real) ou haversine (linha reta).';

-- Índice parcial para relatórios de custo de entrega por período/distância.
create index if not exists orders_delivery_distance_idx
  on public.orders (establishment_id, created_at desc)
  where delivery_distance_km is not null;
