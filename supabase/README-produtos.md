# Setup — Gestão de Cardápio/Produtos (`/painel/produtos`)

Este módulo adiciona a gestão de categorias, produtos e **adicionais
(opcionais)** do estabelecimento. Depende das tabelas `categories`, `products` e
`addons` e das rotas `/api/products`, `/api/categories` e `/api/addons`.

## 1) Aplicar a migração no Supabase

Antes de usar a tela, execute as migrações no **SQL Editor** do Supabase
(Dashboard → SQL → New query). Os scripts são idempotentes (podem rodar mais de
uma vez):

```
supabase/migrations/20261110000002_create_products_and_categories.sql
supabase/migrations/20261110000003_create_addons.sql
supabase/migrations/20261110000004_add_is_required_to_addons.sql
supabase/migrations/20261110000008_add_stock_to_products.sql
supabase/migrations/20261110000011_create_coupons.sql
```

Elas criam:

- `public.categories` — categorias do cardápio (`name`, `position`, `is_active`),
  vinculadas a `establishments` com `on delete cascade`.
- `public.products` — itens do cardápio (`name`, `description`, `price`,
  `image_url`, `is_active`, `position`), com `category_id` usando
  `on delete set null` (excluir uma categoria não apaga os produtos).
  - `track_stock` / `stock_quantity` — controle de estoque opcional (migração
    `20261110000008_add_stock_to_products.sql`). Com `track_stock = true` e
    `stock_quantity = 0`, o produto aparece como **Esgotado** na vitrine.
- `public.addons` — adicionais/opcionais por produto (`name`, `price`,
  `is_required`, `is_active`, `position`), com `product_id` usando
  `on delete cascade`
  (excluir um produto apaga os seus adicionais) e `establishment_id` para o
  escopo do estabelecimento.
- `public.coupons` — cupons de desconto por estabelecimento (`code` único em
  caixa alta, `discount_type` = `percentage`/`fixed`, `discount_value`,
  `min_order_value`, `usage_limit`, `used_count`, `active`), além das colunas
  `coupon_id`/`coupon_code`/`coupon_discount` em `orders` e da função atômica
  `consume_coupon_usage(uuid)`.
- Triggers de `updated_at` e políticas de **RLS**:
  - **Leitura**: o dono do estabelecimento (`auth.uid() = user_id`) e o super admin.
  - **Escrita**: apenas via rotas de API (service role), sem policy de escrita
    para clientes — igual ao padrão de `establishments`.

> O script reutiliza a função `public.is_super_admin()` e
> `public.set_updated_at()` já definidas em `supabase/schema.sql`. Aplique o
> `schema.sql` (ou a migração `20261110000000_create_establishments.sql`)
> primeiro caso ainda não o tenha feito.

## 2) Identificação do estabelecimento

- **admin**: a tela resolve automaticamente o seu `establishment_id` via RLS
  (`establishments_select_own`) — não há seletor de loja.
- **super_admin**: vê um **dropdown** no topo para alternar entre todos os
  estabelecimentos (via `establishments_select_super_admin`).

## 3) Rotas de API (service role)

Todas exigem sessão autenticada e autorização por estabelecimento
(`lib/supabase/menuGuard.ts`).

| Método | Rota                | Descrição                                              |
| ------ | ------------------- | ------------------------------------------------------ |
| GET    | `/api/products?establishment_id=xxx` | Lista categorias + produtos + addons do estabelecimento. |
| POST   | `/api/products`     | Cria um produto (`admin` usa o próprio estabelecimento).|
| PUT    | `/api/products`     | Atualiza dados e/ou `is_active` (pausar/retomar).      |
| DELETE | `/api/products`     | Exclui um produto.                                     |
| GET    | `/api/categories?establishment_id=xxx` | Lista categorias.                     |
| POST   | `/api/categories`   | Cria uma categoria (posição automática no fim).        |
| PUT    | `/api/categories`   | Renomeia/pausa OU reordena em lote (`{ order: [...] }`).|
| DELETE | `/api/categories?id=xxx` | Exclui uma categoria (produtos ficam "sem categoria").|
| GET    | `/api/addons?establishment_id=xxx&product_id=yyy` | Lista adicionais (filtro por produto opcional). |
| POST   | `/api/addons`       | Cria um adicional (`is_required?`, valida `product_id` × estabelecimento). |
| PUT    | `/api/addons`       | Atualiza nome/preço/`is_required`/`is_active`.        |
| DELETE | `/api/addons`       | Exclui um adicional.                                   |

> **Estoque:** `POST`/`PUT /api/products` aceitam `track_stock` (boolean) e
> `stock_quantity` (inteiro ≥ 0). Com `track_stock = false`, o produto tem
> estoque ilimitado e a quantidade é gravada como 0. Requer a migração
> `20261110000008_add_stock_to_products.sql`.

### Rotas de pedidos e clientes (service role)

Mesmo padrão de guarda/escopo, alinhadas às tabelas padronizadas `orders` e
`customers`:

| Método | Rota                | Descrição                                              |
| ------ | ------------------- | ------------------------------------------------------ |
| GET    | `/api/orders?establishment_id=xxx&status=yyy&date=YYYY-MM-DD` | Lista pedidos (mais recentes primeiro; `status` opcional: `pendente`, `preparando`, `entrega`, `finalizado`, `cancelado`; `date` opcional filtra o dia no fuso da loja). |
| POST   | `/api/orders`       | Cria o pedido do checkout (valores recalculados no servidor; aceita `coupon_code` opcional e grava o desconto). |
| PUT    | `/api/orders`       | Atualiza o `status` para qualquer etapa válida (avançar, voltar, pular etapas ou reativar um pedido cancelado). |
| GET    | `/api/dashboard?period=day|month|year&value=...&establishment_id=xxx` | KPIs de vendas (faturamento, pedidos, ticket médio), destaques de maior/menor dia e série temporal do período. `value`: `YYYY-MM-DD` (day), `YYYY-MM` (month) ou `YYYY` (year). |
| GET    | `/api/customers?establishment_id=xxx` | Lista clientes do estabelecimento.        |
| POST   | `/api/customers`    | Cria um cliente (`admin` usa o próprio estabelecimento).|
| DELETE | `/api/customers`    | Exclui um cliente.                                     |
| GET    | `/api/customers/history?establishment_id=xxx[&key=...]` | Agrupa os clientes a partir dos pedidos (nome/telefone, total de pedidos, faturamento, ticket médio e último pedido). Com `key`, devolve o histórico completo do cliente. |

### Rotas de cupons

| Método | Rota                | Descrição                                              |
| ------ | ------------------- | ------------------------------------------------------ |
| GET    | `/api/coupons?establishment_id=xxx` | Lista os cupons do estabelecimento (mais recentes primeiro). |
| POST   | `/api/coupons`      | Cria um cupom (`code`, `discount_type`, `discount_value`, `min_order_value?`, `usage_limit?`, `active?`). |
| PUT    | `/api/coupons`      | Atualiza um cupom (parcial; `{ id, active }` pausa/retoma). |
| DELETE | `/api/coupons`      | Exclui um cupom (`{ id }`); pedidos antigos mantêm o desconto gravado. |
| POST   | `/api/coupons/validate` | **Pública**: valida código/loja/pedido mínimo/limite e devolve o desconto calculado para o checkout. |

> **Cupom no pedido:** o desconto é sempre recalculado em `POST /api/orders`
> (nunca confia no navegador), aplicado sobre o subtotal (sem a taxa de entrega)
> e gravado em `orders.coupon_code`/`coupon_discount`. O `used_count` é
> incrementado após o pedido ser criado, via `consume_coupon_usage`.

> **Nota:** as rotas de `orders`/`customers` usam `select("*")` para tolerar
> variações do schema; colunas mínimas assumidas: `orders` → `id`,
> `establishment_id`, `status`, `created_at`; `customers` → `id`,
> `establishment_id`, `name`, `created_at`.
>
> **Cancelamento:** `PUT /api/orders` exige `cancellation_reason` quando
> `status = "cancelado"` (migração
> `20261110000010_add_cancellation_reason_to_orders.sql`). O motivo é exibido
> no acompanhamento público do pedido e em "Meus Pedidos". Não há restrição de
> transição: o painel pode reativar um pedido cancelado voltando para
> `pendente`, `preparando`, `entrega` ou `finalizado`, e nesse caso o motivo é
> limpo automaticamente.

## 4) Variáveis de ambiente

Reutiliza as mesmas do projeto (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`). A service role é
usada **apenas no servidor** (Route Handlers), nunca exposta ao cliente.
