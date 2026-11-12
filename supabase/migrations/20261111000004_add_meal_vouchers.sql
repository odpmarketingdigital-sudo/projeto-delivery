-- ============================================================================
--  Migração: Vale-Refeição / Vale-Alimentação na ENTREGA (maquininha)
--  Execute no SQL Editor do Supabase (idempotente).
--
--  1) `establishments.accepted_meal_vouchers` (jsonb not null default '[]'):
--     lista das bandeiras de vale-refeição/alimentação que a loja aceita
--     cobrar PRESENCIALMENTE na entrega (maquininha). Array de strings, ex.:
--     ["Alelo","Sodexo / Pluxee","Ticket"]. Lista vazia = loja não aceita
--     vale na entrega (a opção nem aparece no checkout).
--  2) `orders.meal_voucher` (text): bandeira escolhida pelo cliente no
--     checkout. `NULL` em todas as demais formas de pagamento.
--
--  Regras:
--   - O painel (`/painel/configuracoes`) grava a lista via
--     `PUT /api/establishment`;
--   - `/api/menu` devolve a lista em `StorefrontInfo.accepted_meal_vouchers`;
--   - O checkout só mostra "Vale-Refeição / Alimentação" quando a lista não
--     está vazia e exige a escolha da bandeira;
--   - `POST /api/orders` revalida a bandeira contra a lista da loja (fonte da
--     verdade) e grava `payment_method = 'vale_refeicao'` + `meal_voucher`.
--
--  IMPORTANTE: esta modalidade é exclusiva de cobrança PRESENCIAL na entrega.
--  Ela nunca aciona gateway online (PIX Asaas) nem split de pagamentos.
--
--  Compatibilidade: enquanto esta migração não rodar as colunas simplesmente
--  não existem — a loja continua com "nenhum vale aceito" e o painel avisa
--  que a coluna está pendente, sem derrubar o restante das configurações.
-- ============================================================================

alter table public.establishments
  add column if not exists accepted_meal_vouchers jsonb not null default '[]'::jsonb;

-- Bases legadas: normaliza nulos/formatos inesperados antes da constraint.
update public.establishments
   set accepted_meal_vouchers = '[]'::jsonb
 where accepted_meal_vouchers is null
    or jsonb_typeof(accepted_meal_vouchers) <> 'array';

alter table public.establishments
  alter column accepted_meal_vouchers set default '[]'::jsonb,
  alter column accepted_meal_vouchers set not null;

do $$
begin
  alter table public.establishments
    add constraint establishments_accepted_meal_vouchers_is_array
    check (jsonb_typeof(accepted_meal_vouchers) = 'array');
exception when duplicate_object then null;
end
$$;

comment on column public.establishments.accepted_meal_vouchers is
  'Bandeiras de vale-refeição/alimentação aceitas na entrega (maquininha). [] = não aceita.';

-- Bandeira escolhida pelo cliente (somente quando payment_method = 'vale_refeicao').
alter table public.orders
  add column if not exists meal_voucher text;

comment on column public.orders.meal_voucher is
  'Bandeira do vale-refeição/alimentação escolhida para pagamento na entrega. NULL nas demais formas.';
