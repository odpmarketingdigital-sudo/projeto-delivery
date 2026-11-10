-- ============================================================================
--  Migração: PIX Online no checkout (Split de Pagamentos Asaas) — Etapa 2
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) establishments.asaas_api_key
--     Credencial (API key) da SUBCONTA do lojista. A cobrança PIX é criada
--     DENTRO da subconta (o lojista é o recebedor principal; o saldo restante
--     do split fica na conta que emitiu a cobrança) e o `split` envia
--     R$ 0,50 para a carteira da plataforma Ipepper
--     (`ASAAS_PLATFORM_WALLET_ID`).
--     O Asaas devolve a chave apenas na criação da subconta (POST /accounts):
--     depois ela não é recuperável, por isso precisa ser guardada aqui.
--
--     ATENÇÃO: coluna sensível. É lida SOMENTE por rotas server-side (service
--     role) e nunca é devolvida por `/api/menu`, `/api/asaas/subaccount` (GET)
--     ou para o navegador.
--
--  2) orders: campos do pagamento online
--     asaas_payment_id     → id da cobrança no Asaas (POST /v3/payments)
--     payment_status       → pendente | pago | expirado | cancelado
--     payment_confirmed_at → momento da confirmação (webhook)
--     customer_document    → CPF/CNPJ do pagador (obrigatório no Asaas)
--     pix_payload          → Pix Copia e Cola (reexibido no acompanhamento)
--     pix_expiration       → validade do QR Code dinâmico
-- ============================================================================

alter table public.establishments
  add column if not exists asaas_api_key text;

comment on column public.establishments.asaas_api_key is
  'API key da subconta do lojista no Asaas (cria cobranças PIX dentro da subconta). Nunca expor no cliente.';

alter table public.orders
  add column if not exists asaas_payment_id text,
  add column if not exists payment_status text not null default 'pendente',
  add column if not exists payment_confirmed_at timestamptz,
  add column if not exists customer_document text,
  add column if not exists pix_payload text,
  add column if not exists pix_expiration timestamptz;

comment on column public.orders.asaas_payment_id is
  'ID da cobrança PIX no Asaas (POST /v3/payments).';
comment on column public.orders.payment_status is
  'Situação do pagamento online: pendente | pago | expirado | cancelado. Pedidos presenciais permanecem pendente.';
comment on column public.orders.payment_confirmed_at is
  'Momento em que o webhook (ou a conciliação) confirmou o pagamento.';
comment on column public.orders.customer_document is
  'CPF/CNPJ do pagador (somente dígitos) — exigido pelo Asaas na cobrança.';
comment on column public.orders.pix_payload is
  'Pix Copia e Cola devolvido pelo Asaas (para reexibir no acompanhamento).';
comment on column public.orders.pix_expiration is
  'Validade do QR Code dinâmico do Pix.';

-- Busca da cobrança pelo id do Asaas (fallback do webhook) e filtros do painel.
create index if not exists orders_asaas_payment_id_idx
  on public.orders (asaas_payment_id)
  where asaas_payment_id is not null;

create index if not exists orders_payment_status_idx
  on public.orders (payment_status)
  where payment_status <> 'pendente';
