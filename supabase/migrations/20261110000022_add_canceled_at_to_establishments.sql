-- ============================================================================
--  Migração: data de cancelamento da assinatura
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) `establishments.canceled_at` — momento em que o lojista (ou o Super
--     Admin) cancelou o plano. Serve de histórico: `subscription_status` diz
--     apenas QUE está cancelada, não QUANDO.
--  2) Índice para relatórios de churn (cancelamentos por período).
--
--  A rota `POST /api/billing/cancel` preenche a coluna depois que o Asaas
--  confirma o `DELETE /subscriptions/{id}`. Enquanto esta migração não rodar, a
--  rota continua funcionando (grava só o status) e a tela de assinatura exibe
--  "—" no lugar da data.
--
--  RLS inalterada: leitura limitada ao dono (`auth.uid() = user_id`) e ao super
--  admin; escritas continuam exclusivas das rotas de API via service role.
-- ============================================================================

alter table public.establishments
  add column if not exists canceled_at timestamptz;

comment on column public.establishments.canceled_at is
  'Momento do cancelamento da assinatura (null enquanto não houver cancelamento).';

create index if not exists establishments_canceled_at_idx
  on public.establishments (canceled_at)
  where canceled_at is not null;
