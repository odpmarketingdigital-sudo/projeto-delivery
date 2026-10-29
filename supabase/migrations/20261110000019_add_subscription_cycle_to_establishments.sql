-- ============================================================================
--  Migração: ciclo contratado e próxima renovação da assinatura
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) Colunas novas em `public.establishments`:
--     - subscription_cycle      → 'monthly' | 'semiannual' | 'annual'
--     - subscription_expires_at → fim do período pago / próxima renovação
--  2) Índice para relatórios de renovação (assinaturas a vencer).
--
--  Por que existem: o card "Situação da conta" (/painel/assinatura) mostra o
--  plano contratado ("Plano Anual Ativo") e a data de vencimento/renovação.
--  Sem essas colunas a tela só teria o status genérico (`active`) e dependeria
--  do Asaas em cada carregamento.
--
--  Compatibilidade: são colunas anuláveis. O checkout grava ambas ao contratar
--  e o `GET /api/billing/status` reconcilia com o gateway (ciclo e
--  `nextDueDate`), cobrindo assinaturas criadas antes desta migração.
--
--  RLS inalterada: leitura pelo dono/super admin, escrita apenas pelas rotas de
--  API (service role).
-- ============================================================================

alter table public.establishments
  add column if not exists subscription_cycle text,
  add column if not exists subscription_expires_at date;

-- Valores aceitos do ciclo (idempotente: ignora constraint já existente).
do $$
begin
  alter table public.establishments
    add constraint establishments_subscription_cycle_valid
    check (
      subscription_cycle is null
      or subscription_cycle in ('monthly', 'semiannual', 'annual')
    );
exception when duplicate_object then null;
end $$;

comment on column public.establishments.subscription_cycle is
  'Ciclo contratado: monthly, semiannual ou annual (null em bases legadas).';
comment on column public.establishments.subscription_expires_at is
  'Fim do período pago / próxima renovação (data do próximo vencimento).';

create index if not exists establishments_subscription_expires_at_idx
  on public.establishments (subscription_expires_at);
