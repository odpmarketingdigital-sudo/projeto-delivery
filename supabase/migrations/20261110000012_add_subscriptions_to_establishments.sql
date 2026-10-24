-- ============================================================================
--  Migração: assinaturas e trial (SaaS de autoatendimento — Etapa 1)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) Colunas de assinatura em `public.establishments`:
--     - trial_ends_at       → fim dos 30 dias grátis (default: now() + 30 dias)
--     - subscription_status → 'trialing' | 'active' | 'past_due' | 'canceled'
--     - subscription_id     → id da assinatura no gateway de pagamento
--     - customer_payment_id → id do cliente no gateway de pagamento
--     - plan_id             → identificador do plano contratado
--  2) Índices para cobrança/relatórios (status, fim do trial e id da assinatura).
--
--  Importante: esta migração NÃO bloqueia nada. O bloqueio de acesso quando o
--  trial expira (paywall) e a cobrança em si entram nas próximas etapas; aqui
--  apenas persistimos o estado da assinatura. O cardápio público continua
--  funcionando normalmente para todas as lojas.
--
--  RLS inalterada: leitura limitada ao dono (`auth.uid() = user_id`) e ao super
--  admin; escritas continuam exclusivas das rotas de API via service role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Colunas de assinatura
--    O DEFAULT cobre o cadastro público: toda loja nova nasce em trial por 30
--    dias. Em bases já migradas, o ADD COLUMN com default volátil também
--    preenche as linhas existentes (o Postgres reescreve a tabela).
-- ---------------------------------------------------------------------------
alter table public.establishments
  add column if not exists trial_ends_at timestamptz not null
    default (now() + interval '30 days'),
  add column if not exists subscription_status text not null
    default 'trialing',
  add column if not exists subscription_id text,
  add column if not exists customer_payment_id text,
  add column if not exists plan_id text;

-- Regulariza bancos com migração parcial (coluna criada sem default/nulls).
-- Lojas que já existiam entram como `trialing` com uma janela de 30 dias a
-- partir da execução desta migração (período de graça para migrarem de plano).
-- Se a regra de negócio for "lojas antigas já são clientes ativos", basta rodar
--   update public.establishments set subscription_status = 'active'
--    where created_at < '<data da migração>';
-- antes de ativar o paywall da próxima etapa.
update public.establishments
   set trial_ends_at = now() + interval '30 days'
 where trial_ends_at is null;

update public.establishments
   set subscription_status = 'trialing'
 where subscription_status is null;

alter table public.establishments
  alter column trial_ends_at set default (now() + interval '30 days'),
  alter column subscription_status set default 'trialing';

alter table public.establishments
  alter column trial_ends_at set not null,
  alter column subscription_status set not null;

-- Valores aceitos de status (idempotente: ignora constraint já existente).
do $$
begin
  alter table public.establishments
    add constraint establishments_subscription_status_valid
    check (subscription_status in ('trialing', 'active', 'past_due', 'canceled'));
exception when duplicate_object then null;
end $$;

comment on column public.establishments.trial_ends_at is
  'Fim do período de teste grátis (30 dias a partir do cadastro).';
comment on column public.establishments.subscription_status is
  'Estado da assinatura: trialing, active, past_due ou canceled.';
comment on column public.establishments.subscription_id is
  'Identificador da assinatura no gateway de pagamento (null enquanto não assinar).';
comment on column public.establishments.customer_payment_id is
  'Identificador do cliente no gateway de pagamento.';
comment on column public.establishments.plan_id is
  'Identificador do plano contratado (ex.: starter, pro).';

-- ---------------------------------------------------------------------------
-- 2) Índices
-- ---------------------------------------------------------------------------
create index if not exists establishments_subscription_status_idx
  on public.establishments (subscription_status);

create index if not exists establishments_trial_ends_at_idx
  on public.establishments (trial_ends_at);

-- Uma assinatura do gateway pertence a uma única loja (quando informada).
create unique index if not exists establishments_subscription_id_key
  on public.establishments (subscription_id)
  where subscription_id is not null;
