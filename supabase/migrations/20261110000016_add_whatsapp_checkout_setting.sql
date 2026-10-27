-- =============================================================================
-- Envio do resumo do pedido para o WhatsApp da loja (checkout)
-- =============================================================================
-- Execute no SQL Editor do Supabase (idempotente).
--
-- Campo adicionado em `public.establishments`:
--   whatsapp_checkout_enabled  liga/desliga o botão "enviar resumo do pedido
--                              no WhatsApp" ao finalizar o checkout.
--
-- O pedido continua sendo gravado em `public.orders` normalmente; o WhatsApp é
-- apenas um canal adicional de comunicação com a loja.
-- =============================================================================

alter table public.establishments
  add column if not exists whatsapp_checkout_enabled boolean not null default true;

comment on column public.establishments.whatsapp_checkout_enabled is
  'Quando true, o checkout oferece o envio do resumo do pedido para o WhatsApp da loja (padrão true).';
