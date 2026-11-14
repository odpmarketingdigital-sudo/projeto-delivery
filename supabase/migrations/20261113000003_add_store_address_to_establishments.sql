-- ============================================================================
--  Endereço da loja por extenso (origem do cálculo do frete)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  A origem do frete por distância deixa de ser configurada por CEP e passa a
--  ser um endereço livre digitado pelo lojista (rua + número + bairro + cidade).
--  O texto é geocodificado em `/api/geocode?address=...` (Nominatim) e as
--  coordenadas exatas retornadas são gravadas em `store_latitude` /
--  `store_longitude` — que continuam sendo a fonte da verdade da cotação
--  (`lib/deliveryQuote.ts`).
--
--  `store_cep` é mantido: ainda é usado no preenchimento da subconta Asaas e
--  como fallback de geocodificação para lojas antigas.
-- ============================================================================

alter table public.establishments
  add column if not exists store_address text;

comment on column public.establishments.store_address is
  'Endereço da loja por extenso (rua, número, bairro, cidade) usado como origem do cálculo de frete por distância.';
