-- ============================================================================
--  Migração: controle de inadimplência (suspensão após 15 dias de atraso)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) Colunas novas em `public.establishments`:
--     - payment_due_date     → vencimento da cobrança EM ABERTO (Asaas
--                              `payment.dueDate`); null quando está tudo pago
--     - payment_invoice_url  → link da fatura no Asaas, usado pelo banner de
--                              regularização do painel
--     - last_payment_at      → momento do último pagamento recebido
--     - overdue_suspended_at → quando a suspensão automática por atraso foi
--                              aplicada (null enquanto nunca/regularizado)
--  2) Índices para a rotina de cobrança (faturas vencidas e lojas suspensas).
--
--  Regra de negócio (`lib/storeEligibility.ts`):
--    atraso > 15 dias → loja fora do ar (`/[slug]` exibe "loja indisponível")
--    e `status` vira `inativo`. O pagamento aprovado limpa `payment_due_date`
--    e devolve a loja ao ar (`restoreStoreAfterPayment`).
--
--  Compatibilidade: todas as colunas são anuláveis. Enquanto esta migração não
--  rodar, o webhook e a vitrine continuam funcionando: a leitura cai para as
--  colunas antigas e a suspensão automática por data fica inativa (apenas
--  `status`/`subscription_status` derrubam a loja).
--
--  RLS inalterada: leitura pelo dono/super admin, escrita apenas pelas rotas de
--  API (service role).
-- ============================================================================

alter table public.establishments
  add column if not exists payment_due_date date,
  add column if not exists payment_invoice_url text,
  add column if not exists last_payment_at timestamptz,
  add column if not exists overdue_suspended_at timestamptz;

comment on column public.establishments.payment_due_date is
  'Vencimento da cobrança em aberto (null quando não há fatura pendente).';
comment on column public.establishments.payment_invoice_url is
  'Link da fatura no Asaas usada no banner de regularização do painel.';
comment on column public.establishments.last_payment_at is
  'Momento do último pagamento recebido (PAYMENT_RECEIVED/CONFIRMED).';
comment on column public.establishments.overdue_suspended_at is
  'Momento da suspensão automática por atraso > 15 dias (null quando regularizado).';

create index if not exists establishments_payment_due_date_idx
  on public.establishments (payment_due_date)
  where payment_due_date is not null;

create index if not exists establishments_overdue_suspended_at_idx
  on public.establishments (overdue_suspended_at)
  where overdue_suspended_at is not null;
