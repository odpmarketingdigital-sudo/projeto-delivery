-- ============================================================================
--  Migração: recebimento online / Split de Pagamentos (Asaas Subcontas)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  Contexto (Etapa 1 da integração com o Asaas no modelo Split/Subcontas):
--  cada estabelecimento passa a poder conectar uma CONTA DE RECEBIMENTO
--  (subconta) no Asaas. A plataforma cobra R$ 0,50 por pedido pago online e
--  repassa o restante para a subconta do lojista (o split em si é montado nas
--  próximas etapas, usando o `asaas_wallet_id` guardado aqui).
--
--  Colunas:
--    asaas_account_id  → id da subconta no Asaas (POST /accounts). null quando
--                        a loja ainda não conectou o recebimento online.
--    asaas_wallet_id   → carteira (wallet) da subconta, destino do split.
--    asaas_subaccount  → snapshot (jsonb) dos dados de recebimento enviados ao
--                        Asaas, usado para reabrir o formulário já preenchido.
--    pix_key           → chave PIX de resgate informada pelo lojista.
--    accept_pix_online → liga/desliga o PIX online no cardápio.
-- ============================================================================

alter table public.establishments
  add column if not exists asaas_account_id text,
  add column if not exists asaas_wallet_id text,
  add column if not exists asaas_subaccount jsonb,
  add column if not exists pix_key text,
  add column if not exists accept_pix_online boolean not null default false;

comment on column public.establishments.asaas_account_id is
  'ID da subconta (conta de recebimento) no Asaas. null = pagamento online não conectado.';
comment on column public.establishments.asaas_wallet_id is
  'Wallet ID da subconta no Asaas — destino dos splits de pagamento.';
comment on column public.establishments.asaas_subaccount is
  'Snapshot (jsonb) dos dados de recebimento enviados ao Asaas ao criar a subconta.';
comment on column public.establishments.pix_key is
  'Chave PIX de resgate informada pelo lojista (repasse dos valores).';
comment on column public.establishments.accept_pix_online is
  'Quando true, o cardápio aceita PIX online no checkout (Split de Pagamentos).';

-- Busca rápida por subconta ao reconciliar webhooks/splits nas próximas etapas.
create index if not exists establishments_asaas_account_id_idx
  on public.establishments (asaas_account_id)
  where asaas_account_id is not null;

-- RLS: as colunas herdam as policies de SELECT já existentes em
-- `establishments` (dono lê o próprio registro; super admin lê todos). As
-- escritas continuam exclusivas das rotas de API via service role (bypass RLS).
