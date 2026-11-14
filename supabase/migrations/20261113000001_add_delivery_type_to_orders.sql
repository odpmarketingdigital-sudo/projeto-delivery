-- ============================================================================
--  Modalidade de atendimento do pedido (entrega x retirada no balcão)
-- ============================================================================
--  O checkout passa a perguntar ao cliente como ele quer receber o pedido:
--
--    'entrega'  → receber em casa (taxa de entrega + endereço obrigatórios);
--    'retirada' → retirar no estabelecimento (sem taxa e sem endereço).
--
--  A coluna é gravada em `public.orders` no momento da criação do pedido e é
--  usada por:
--    - painel: rótulo "Pronto para buscar" na etapa final de pedidos retirados;
--    - notificações WhatsApp (cliente e loja);
--    - página de acompanhamento `/pedido/[id]`.
--
--  Pedidos anteriores a esta migração são classificados pela presença de
--  endereço — mesma regra que o painel já usava (sem endereço = retirada).
-- ============================================================================

alter table public.orders
  add column if not exists delivery_type text;

-- Backfill: pedidos com endereço continuam como entrega; sem endereço, retirada.
update public.orders
set delivery_type = case
  when coalesce(customer_address->>'street', '') = ''
   and coalesce(customer_address->>'number', '') = ''
   and coalesce(customer_address->>'neighborhood', '') = ''
  then 'retirada'
  else 'entrega'
end
where delivery_type is null;

-- Novos pedidos que não enviarem o campo assumem entrega (compatibilidade com
-- clientes antigos do app/cardápio já em cache).
alter table public.orders
  alter column delivery_type set default 'entrega';

do $$
begin
  alter table public.orders
    add constraint orders_delivery_type_valid
    check (delivery_type is null or delivery_type in ('entrega', 'retirada'));
exception when duplicate_object then null;
end $$;

comment on column public.orders.delivery_type is
  'Modalidade escolhida no checkout: entrega (domicílio) ou retirada (balcão).';

create index if not exists orders_delivery_type_idx
  on public.orders (establishment_id, delivery_type);
