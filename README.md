This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Assinatura (Asaas)

- `POST /api/billing/checkout` — cria (ou reaproveita) a cobrança da assinatura;
- `GET /api/billing/status` — reconcilia o estado pelo polling da tela de assinatura;
- `POST /api/billing/cancel` — cancela a assinatura do próprio lojista: remove a
  recorrência no Asaas (`DELETE /subscriptions/{id}`) e só depois marca a loja
  como `subscription_status = 'canceled'`, `canceled_at = now()` e
  `status = 'inativo'`. Se o gateway falhar, nada muda no banco e a rota devolve
  erro (a tela mostra a mensagem no próprio modal);
- `POST /api/webhooks/asaas` — recebe as notificações do Asaas e atualiza a loja
  (token validado via `ASAAS_WEBHOOK_TOKEN`).

Migrações relacionadas: `20261110000012_add_subscriptions_to_establishments.sql`,
`20261110000019_add_subscription_cycle_to_establishments.sql`,
`20261110000022_add_canceled_at_to_establishments.sql` (coluna `canceled_at`)
e `20261110000023_add_overdue_tracking_to_establishments.sql` (colunas
`payment_due_date`, `payment_invoice_url`, `last_payment_at` e
`overdue_suspended_at`; sem elas o restante continua funcionando, apenas sem a
suspensão automática por data).

### Inadimplência — suspensão após 15 dias

- Regra única em [`lib/storeEligibility.ts`](lib/storeEligibility.ts)
  (`evaluateStoreEligibility` / `getDaysOverdue`): atraso **maior que**
  `OVERDUE_GRACE_DAYS` (15 dias) tira a loja do ar. A contagem parte do
  vencimento da fatura em aberto (`payment_due_date`) — ou do fim do período
  pago/trial, quando for posterior — então quem ainda tem o mês quitado nunca é
  suspenso;
- Webhook (`POST /api/webhooks/asaas`): `PAYMENT_OVERDUE` e
  `PAYMENT_DUNNING_RECEIVED` gravam o vencimento/link da fatura;
  `PAYMENT_RECEIVED`/`PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED_IN_CASH` limpam esses
  campos e gravam `last_payment_at`. `GET /api/billing/status` faz a mesma
  reconciliação durante o polling da tela de assinatura;
- Fallback dinâmico em `/[slug]`: `resolvePublicStore` recalcula o atraso a cada
  acesso e, se passou da carência, grava `status = 'inativo'` +
  `overdue_suspended_at` (service role) antes de exibir a página
  `StoreUnavailable` — cobre eventos de webhook perdidos;
- Pagamento aprovado reativa a loja suspensa (`restoreStoreAfterPayment` limpa
  `overdue_suspended_at` e `payment_due_date`);
- No painel, `OverdueBanner` mostra um aviso em destaque quando o atraso passa de
  15 dias, com botão direto para a fatura no Asaas
  (`establishments.payment_invoice_url`) e link para `/painel/assinatura`.

Passo a passo de configuração do webhook (Sandbox e Produção):
[`docs/asaas-webhook.md`](docs/asaas-webhook.md).

## Vitrine pública (`/[slug]`)

- O cardápio só é servido quando a loja está `status = 'ativo'`, com
  `subscription_status <> 'canceled'` **e** sem atraso acima de 15 dias — regra
  única em [`lib/storeAvailability.ts`](lib/storeAvailability.ts)
  (`resolvePublicStore`) sobre o helper puro
  [`lib/storeEligibility.ts`](lib/storeEligibility.ts);
- Loja cancelada/inativa → página `StoreUnavailable`: nome do estabelecimento,
  mensagem "Este estabelecimento está temporariamente indisponível no momento."
  e `noindex`, sem produtos e sem checkout (`/[slug]/checkout` também bloqueia);
- A mesma checagem é refeita no servidor em `GET /api/menu` e `POST /api/orders`
  (403 `Esta loja não está online no momento.`), evitando cardápio/pedidos por
  link ou aba antiga — no `POST /api/orders` a checagem roda antes da validação
  do carrinho/cliente, então nem um payload válido cria pedido para loja offline;
- Toda rota que muda o status chama `revalidatePublicStore(slug)`
  (`/api/billing/cancel`, webhook do Asaas, `/api/billing/checkout`,
  `/api/admin/update-establishment`, `/api/admin/subscriptions`,
  `/api/admin/delete-establishment`), então a mudança vale imediatamente no
  link público;
- Pagamento aprovado reativa automaticamente a loja desativada pelo
  cancelamento ou suspensa por atraso (`restoreStoreAfterPayment`, condicionado
  a `canceled_at`/`overdue_suspended_at`) — lojas desligadas manualmente pelo
  Super Admin continuam offline.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
