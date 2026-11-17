-- ============================================================================
--  Migração: Bandeiras de Cartão de Crédito / Débito na ENTREGA
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) `establishments.accepted_credit_brands` (jsonb not null default '[]'):
--     bandeiras de cartão de CRÉDITO que a loja aceita cobrar presencialmente
--     (maquininha). Array de strings, ex.: ["Visa","Mastercard","Elo"].
--  2) `establishments.accepted_debit_brands` (jsonb not null default '[]'):
--     o mesmo para cartões de DÉBITO.
--  3) `orders.card_type` (text): tipo escolhido no checkout — `credito` ou
--     `debito`. `NULL` nas demais formas de pagamento.
--  4) `orders.card_brand` (text): bandeira escolhida no checkout. `NULL` nas
--     demais formas de pagamento (e quando a loja não cadastrou bandeiras).
--
--  Regras:
--   - O painel (`/painel/configuracoes`) grava as listas via
--     `PUT /api/establishment`;
--   - `/api/menu` devolve as listas normalizadas em
--     `StorefrontInfo.accepted_credit_brands` / `accepted_debit_brands`;
--   - O checkout mostra o seletor de tipo/bandeira quando o cliente escolhe
--     "Cartão na Entrega". Com pelo menos uma bandeira cadastrada, a escolha
--     (tipo + bandeira) é OBRIGATÓRIA e só aparecem os tipos que a loja aceita;
--   - `POST /api/orders` revalida tipo/bandeira contra as listas da loja
--     (fonte da verdade) e grava `card_type` + `card_brand`.
--
--  Compatibilidade: enquanto esta migração não rodar as colunas simplesmente
--  não existem — a loja continua vendendo no cartão sem exigir bandeira e o
--  painel avisa que a coluna está pendente, sem derrubar o restante das
--  configurações. O pedido também não é perdido: as colunas novas são
--  removidas do INSERT e a bandeira entra nas observações.
-- ============================================================================

alter table public.establishments
  add column if not exists accepted_credit_brands jsonb not null default '[]'::jsonb;

alter table public.establishments
  add column if not exists accepted_debit_brands jsonb not null default '[]'::jsonb;

-- Bases legadas: normaliza nulos/formatos inesperados antes das constraints.
update public.establishments
   set accepted_credit_brands = '[]'::jsonb
 where accepted_credit_brands is null
    or jsonb_typeof(accepted_credit_brands) <> 'array';

update public.establishments
   set accepted_debit_brands = '[]'::jsonb
 where accepted_debit_brands is null
    or jsonb_typeof(accepted_debit_brands) <> 'array';

alter table public.establishments
  alter column accepted_credit_brands set default '[]'::jsonb,
  alter column accepted_credit_brands set not null,
  alter column accepted_debit_brands set default '[]'::jsonb,
  alter column accepted_debit_brands set not null;

do $$
begin
  alter table public.establishments
    add constraint establishments_accepted_credit_brands_is_array
    check (jsonb_typeof(accepted_credit_brands) = 'array');
exception when duplicate_object then null;
end
$$;

do $$
begin
  alter table public.establishments
    add constraint establishments_accepted_debit_brands_is_array
    check (jsonb_typeof(accepted_debit_brands) = 'array');
exception when duplicate_object then null;
end
$$;

comment on column public.establishments.accepted_credit_brands is
  'Bandeiras de cartão de crédito aceitas na entrega (maquininha). [] = não cadastrou (checkout não exige bandeira).';

comment on column public.establishments.accepted_debit_brands is
  'Bandeiras de cartão de débito aceitas na entrega (maquininha). [] = não cadastrou (checkout não exige bandeira).';

-- Tipo e bandeira escolhidos pelo cliente (somente quando payment_method = 'cartao').
alter table public.orders
  add column if not exists card_type text;

alter table public.orders
  add column if not exists card_brand text;

do $$
begin
  alter table public.orders
    add constraint orders_card_type_check
    check (card_type is null or card_type in ('credito', 'debito'));
exception when duplicate_object then null;
end
$$;

comment on column public.orders.card_type is
  'Tipo do cartão escolhido na entrega: credito | debito. NULL nas demais formas.';

comment on column public.orders.card_brand is
  'Bandeira do cartão escolhida na entrega (ex.: Visa). NULL nas demais formas.';
