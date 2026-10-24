-- ============================================================================
--  Migração: motivo do cancelamento em public.orders (idempotente)
--  Execute no SQL Editor do Supabase (seguro para reexecutar).
--
--  O painel exige que o atendente informe o motivo ao cancelar um pedido.
--  O valor é salvo em `cancellation_reason` e retornado pelo acompanhamento
--  público do pedido (/api/order-status), ficando visível ao cliente.
-- ============================================================================

alter table public.orders
  add column if not exists cancellation_reason text;

comment on column public.orders.cancellation_reason is
  'Motivo informado pelo atendente ao cancelar o pedido (null quando não cancelado).';
