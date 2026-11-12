-- ============================================================================
--  Migração: pedido mínimo por estabelecimento
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) `establishments.min_order_value` (numeric(10,2) not null default 0):
--     valor mínimo do SUBTOTAL dos itens (sem a taxa de entrega) para aceitar
--     o pedido. `0` = loja sem pedido mínimo.
--  2) Constraint de não negatividade.
--
--  Regras:
--   - O painel (`/painel/configuracoes`) grava o valor via
--     `PUT /api/establishment`;
--   - A vitrine, a sacola (`CartDrawer`) e o checkout (`CheckoutForm`) bloqueiam
--     o avanço quando o subtotal é menor que o mínimo;
--   - `POST /api/orders` revalida no servidor (fonte da verdade) e responde 400
--     com a mensagem do valor mínimo.
--
--  Compatibilidade: enquanto esta migração não rodar a coluna simplesmente não
--  existe — a leitura cai para `0` (sem mínimo) e o formulário do painel avisa
--  que a coluna está pendente, sem derrubar o restante das configurações.
-- ============================================================================

alter table public.establishments
  add column if not exists min_order_value numeric(10, 2) not null default 0;

-- Bases legadas: normaliza nulos/negativos antes de aplicar a constraint.
update public.establishments
   set min_order_value = 0
 where min_order_value is null
    or min_order_value < 0;

alter table public.establishments
  alter column min_order_value set default 0,
  alter column min_order_value set not null;

do $$
begin
  alter table public.establishments
    add constraint establishments_min_order_value_non_negative
    check (min_order_value >= 0);
exception when duplicate_object then null;
end
$$;

comment on column public.establishments.min_order_value is
  'Valor mínimo do subtotal dos itens (sem frete) para aceitar o pedido. 0 = sem mínimo.';
