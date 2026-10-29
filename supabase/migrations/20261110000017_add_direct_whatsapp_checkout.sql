-- =============================================================================
-- Modo catálogo: pedido/orçamento direto no WhatsApp (sem checkout)
-- =============================================================================
-- Execute no SQL Editor do Supabase (idempotente).
--
-- Campo adicionado em `public.establishments`:
--   direct_whatsapp_checkout  quando true, a sacola do cardápio deixa de levar o
--                             cliente para o checkout: o botão "Enviar Pedido /
--                             Orçamento" monta a mensagem e abre o WhatsApp da
--                             loja. Indicado para catálogos com preços variáveis
--                             ou itens "Sob Consulta".
--
-- Default `false` para preservar o fluxo de delivery existente (checkout ->
-- pedido gravado em `public.orders`). Nenhuma tabela/pedido é alterado por esta
-- migração; apenas a preferência da loja.
-- =============================================================================

alter table public.establishments
  add column if not exists direct_whatsapp_checkout boolean not null default false;

comment on column public.establishments.direct_whatsapp_checkout is
  'Quando true, a sacola envia o pedido/orçamento direto para o WhatsApp da loja, sem passar pelo checkout (padrão false).';
