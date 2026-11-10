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

## PIX Online no checkout (Split Asaas — Etapa 2)

- `POST /api/asaas/pix-payment` — cria (ou reaproveita) a cobrança PIX do pedido
  `pix_online` dentro da subconta da loja (`POST /v3/payments`) com Split fixo de
  **R$ 0,50** para a carteira da plataforma (`ASAAS_PLATFORM_WALLET_ID`); devolve
  `payload` (Copia e Cola) e `encoded_image` (QR Code);
- `GET /api/asaas/pix-payment?order_id=...` — status para o polling do modal
  (concilia direto com o Asaas quando o webhook ainda não chegou);
- `POST /api/asaas/webhook` — trata `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`,
  marca `orders.payment_status = 'pago'` de forma idempotente e o painel recebe
  o UPDATE pelo Realtime (`postgres_changes` em `orders`);
- O checkout só oferece a opção quando `/api/menu` devolve
  `accept_pix_online: true` (subconta conectada **e** credencial salva) e exige
  CPF/CNPJ do pagador; a confirmação é automática (webhook + fallback de polling).
- **Extrato de Pagamentos** em `/painel/financeiro` (`GET /api/financeiro`):
  cards do mês com total vendido online, taxas da plataforma (R$ 0,50 × pedidos
  pagos) e saldo líquido repassado, mais a tabela por pedido (bruto, taxa,
  líquido, situação do pagamento e do repasse) com filtros Todos/Pagos/Pendentes.
- **Configuração em `/painel/configuracoes`**: badge de situação ao lado do
  título da seção (🟢 Ativo / Conectado, 🟡 Conectado com PIX desativado,
  ⚪ Inativo / Não conectado) e formulário de subconta já preenchido com os
  dados da loja (razão social, CPF/CNPJ, e-mail, telefone e CEP), com
  rua/bairro completados pela consulta de CEP (`/api/geocode`).

Migrações: `20261110000027_add_asaas_subaccount_to_establishments.sql` (Etapa 1)
e `20261110000028_add_asaas_pix_online_payments.sql` (`asaas_api_key` +
colunas de pagamento em `orders`). Passo a passo e variáveis de ambiente:
[`docs/asaas-pix-split.md`](docs/asaas-pix-split.md).

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

### Marca e navegação inferior (visão do cliente)

- A vitrine é **white-label**: o topo do cardápio não exibe o logotipo/marca
  Ipepper (o mesmo vale para o topo do checkout em
  [`app/components/CheckoutForm.tsx`](app/components/CheckoutForm.tsx)). Sem
  `logo_url` cadastrado, o avatar circular usa um ícone neutro de loja em vez de
  `public/logotipo.webp`;
- O rodapé fixo da vitrine empilha, em um único container `fixed bottom-0`, o
  resumo da sacola ([`app/components/CartSummary.tsx`](app/components/CartSummary.tsx))
  e a barra de navegação inferior
  ([`app/components/StorefrontBottomNav.tsx`](app/components/StorefrontBottomNav.tsx))
  com os itens **Cardápio** (rola a página ao topo), **Acompanhar pedido**
  (`/pedido/[id]` quando a sessão tem pedido em andamento ou concluído hoje —
  regra em [`app/components/useTrackableOrder.ts`](app/components/useTrackableOrder.ts))
  e **Meus Pedidos** (`/[slug]/pedidos`);
- A **mesma barra acompanha o cliente nas três telas** do fluxo: cardápio
  (`/[slug]` e `/demo`), acompanhamento (`/pedido/[id]`) e histórico
  (`/[slug]/pedidos`). O componente é único — só muda a prop `active`, que
  destaca a aba com `aria-current="page"` e um traço âmbar; tocar na aba atual
  apenas rola a tela ao topo. Em `PedidoTracker` a barra também aparece durante
  o carregamento e em caso de erro, e fica **antes** do diálogo de cancelamento
  para o modal (`z-50`) pintar por cima dela;
- A troca de aba é navegação de cliente (`next/link`): o `CartProvider` do
  layout raiz não remonta e o carrinho (estado + `localStorage` `@delivery:cart`)
  continua intacto. Para suavizar a troca, o conteúdo de cada aba usa a classe
  `customer-view-enter` (`app/globals.css`, fade de 220 ms que anima **só**
  `opacity` — animar `transform` criaria bloco de contenção e deslocaria a barra
  `fixed`), respeitando `prefers-reduced-motion`;
- Item sem destino (sem pedido ativo, ou sem slug público no `/demo`) mostra uma
  faixa de aviso temporária em vez de um toque sem resposta;
- O espaço do rodapé é reservado no conteúdo: `pb-24` sem sacola, `pb-40` com a
  barra da sacola e `pb-56` com a sacola + aviso de loja fechada na vitrine;
  `pb-28` (`BOTTOM_NAV_CONTENT_PADDING`) nas telas de acompanhamento e
  histórico, então o último item nunca fica coberto.

### Hidratação (SSR × primeiro render do cliente)

A barra inferior e as telas do cliente são renderizadas no servidor (a vitrine
inclusive com Cache Components/PPR). Para o HTML do servidor ser **idêntico** ao
primeiro render do cliente, nada que dependa do navegador entra nessa primeira
passada:

- [`app/components/useIsMounted.ts`](app/components/useIsMounted.ts) expõe
  `useIsMounted()` — `false` no servidor e na hidratação, `true` logo depois.
  É implementado com `useSyncExternalStore` (mesmo padrão do `isHydrated` em
  [`context/CartContext.tsx`](context/CartContext.tsx)), porque
  `useEffect(() => setState(true), [])` é reprovado pela regra
  `react-hooks/set-state-in-effect` do projeto;
- **Relógio do navegador** (`new Date()`, fuso local) só é lido com `isMounted`:
  o selo "Aberto agora"/"Fechado no momento" e o texto "Abre hoje às …" da
  vitrine ([`app/components/Storefront.tsx`](app/components/Storefront.tsx)) e o
  aviso de loja fechada do checkout
  ([`app/components/CheckoutForm.tsx`](app/components/CheckoutForm.tsx)) são
  calculados depois da montagem — no servidor o mesmo horário seria avaliado em
  outro instante/fuso e divergiria;
- **`localStorage` / `sessionStorage`** idem: telefone do cliente em
  `/[slug]/pedidos`, perfil salvo no checkout e o link de resumo no WhatsApp em
  `/pedido/[id]` só aparecem após a montagem (nesse intervalo vale o esqueleto de
  carregamento, igual nos dois lados);
- O carrinho e o CEP usam `useSyncExternalStore` com `getServerSnapshot` vazio,
  então SSR e hidratação sempre concordam (o valor real entra no render
  seguinte);
- `suppressHydrationWarning` existe **apenas** em `<html>` e `<body>`
  ([`app/layout.tsx`](app/layout.tsx)), onde extensões de navegador, tradutores
  automáticos e gerenciadores de senha injetam atributos antes da hidratação.
  Nenhum componente do fluxo do cliente usa essa escape hatch.

## Modo catálogo (pedido direto no WhatsApp)

Recurso em que a sacola deixa de abrir o checkout e passa a enviar o
pedido/orçamento para o WhatsApp da loja (útil para catálogos com preços
variáveis ou itens "Sob Consulta"). Ele é **liberado exclusivamente pelo Super
Admin**:

- `establishments.catalog_mode_allowed` (migração
  `20261110000025_add_catalog_mode_allowed.sql`) nasce `false` em toda loja e só
  muda pelo painel `/painel/admin` (chave "Modo catálogo" na lista) via
  `PUT /api/admin/catalog-mode` — Super Admin verificado por
  [`lib/supabase/adminGuard.ts`](lib/supabase/adminGuard.ts) e escrita com
  service role. O SQL da migração também cria a policy de `update` para
  `public.is_super_admin()` e concede ao `authenticated` privilégio de `update`
  apenas nessa coluna (as demais colunas seguem exclusivas das rotas de API);
- Com a loja liberada, o lojista liga/desliga a chave
  `direct_whatsapp_checkout` em `/painel/configuracoes` (migração
  `20261110000017_add_direct_whatsapp_checkout.sql`). Sem a liberação a chave
  aparece **desativada** com o aviso "Modo Catálogo exclusivo para planos
  liberados" e `PUT /api/establishment` recusa `direct_whatsapp_checkout: true`
  com 403;
- `GET /api/menu` só devolve `direct_whatsapp_checkout: true` quando as duas
  colunas estão `true`, então revogar a liberação devolve a loja ao checkout
  tradicional na hora (a rota também zera a preferência da loja e chama
  `revalidatePublicStore`).

## Identidade visual (logo e banner)

O upload das imagens do estabelecimento em `/painel/configuracoes` otimiza o
arquivo **no navegador** (Canvas API, ver
[`lib/image-resize.ts`](lib/image-resize.ts)) antes de enviar para o bucket
`products` do Supabase Storage:

- **Logo** → recorte central 1:1 em **500 × 500 px**, WebP 85%;
- **Banner/capa** → recorte central 3:1 em **1200 × 400 px**, WebP 85%;
- O recorte é "cover" (estilo `object-fit: cover`), portanto nada é distorcido:
  sobra é cortada nas laterais ou no topo/base;
- A prévia exibida no card é a imagem **já otimizada** (object URL do WebP
  gerado), com as dimensões finais e a comparação de peso
  (`4,1 MB → 62 KB`), e o card mostra o estado "Processando imagem..." durante
  o trabalho do canvas;
- Em navegadores sem encoder WebP a conversão cai para JPEG na mesma qualidade
  — o nome/extensão do arquivo acompanham o MIME realmente gerado;
- Limites: PNG/JPG/WebP de até 20 MB na origem.

## Entrega por distância (Google Maps)

Fluxo do checkout para lojas com entrega por km (`delivery_type = 'distance'`)
ou raio máximo (`max_delivery_radius_km`):

1. **Autocomplete de endereço** — o campo *Rua* do checkout
   ([`AddressAutocomplete.tsx`](app/components/AddressAutocomplete.tsx)) usa a
   Google Maps JS API (Places) para sugerir endereços no Brasil. Ao escolher uma
   sugestão, o formulário recebe **rua, número, bairro, cidade, estado, CEP** e
   as **coordenadas** (`lat`/`lng`), que seguem no corpo do pedido;
2. **Cotação no servidor** — `POST /api/delivery-quote` (pré-visualização) e
   `POST /api/orders` (validação final) chamam a mesma função
   [`quoteDelivery`](lib/deliveryQuote.ts), que:
   - resolve o endereço por coordenadas (Places) ou, na falta delas, pelo CEP
     ([`lib/cep.ts`](lib/cep.ts): BrasilAPI → ViaCEP → Nominatim);
   - calcula a **rota real de carro** com a Google Routes API
     ([`lib/googleRoutes.ts`](lib/googleRoutes.ts), `computeRoutes`,
     `routingPreference: TRAFFIC_AWARE`) devolvendo distância em km e tempo em
     minutos;
   - aplica a regra da loja em [`lib/delivery.ts`](lib/delivery.ts)
     (`computeDistanceFee`: taxa base até `distance_base_km` + valor por km
     excedente) e valida o raio máximo;
3. **Persistência** — o pedido grava `delivery_fee` (valor final) e também
   `delivery_distance_km`, `delivery_duration_minutes` e
   `delivery_distance_source` (`google_routes` | `haversine`), além das
   coordenadas dentro de `customer_address`;
4. **Degradação segura** — sem `GOOGLE_MAPS_API_KEY` (ou em erro/timeout da API)
   a distância cai para linha reta (Haversine), a UI avisa que a taxa pode
   variar e o pedido continua sendo criado. Sem
   `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` o campo de rua vira um input comum.

Variáveis de ambiente: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (navegador, restrita por
HTTP referrer) e `GOOGLE_MAPS_API_KEY` (servidor, Routes API). Passo a passo,
restrições e custos: [`docs/google-maps-delivery.md`](docs/google-maps-delivery.md).

Migração relacionada: `20261110000024_add_delivery_distance_to_orders.sql`
(colunas `delivery_distance_km`, `delivery_duration_minutes` e
`delivery_distance_source` em `orders`; sem ela o pedido é gravado normalmente,
apenas sem esses campos).

## Importar cardápio com IA (Google Gemini)

> **⚠️ Desativada temporariamente:** a chave `GEMINI_API_KEY` está sem créditos,
> então o botão **Importar com IA** e o modal não são renderizados no painel. O
> controle é a constante `MENU_AI_IMPORT_ENABLED` em
> [`app/painel/produtos/PainelProdutos.tsx`](app/painel/produtos/PainelProdutos.tsx)
> (`false` = oculto). As rotas, o modal e o restante do fluxo continuam no
> código e voltam a funcionar ao trocar a constante para `true`; nada mais
> precisa ser alterado. O cadastro manual de categorias, produtos e preços não
> é afetado.

Em **Painel → Cardápio**, o botão **Importar com IA** abre o envio de um PDF ou
foto do cardápio atual. O fluxo tem duas etapas, sempre com revisão humana:

1. **Upload** — `ImportMenuModal.tsx` aceita PDF, PNG e JPG de até 10 MB
   (mesmo limite da rota) e envia o arquivo por `multipart/form-data` para
   `POST /api/ai/import-menu`;
2. **Extração** — a rota valida a sessão/permissão (`requireMenuAccess`,
   `resolveMenuEstablishment`, `canManageEstablishment`), envia o arquivo ao
   Gemini (`@google/genai`, padrão `gemini-2.5-flash`) via `inlineData` com
   **Structured Output** (`responseMimeType: "application/json"` +
   `responseSchema`) e devolve `{ menu, establishment_id }`. O prompt e o
   schema vivem em [`lib/ai/menuImport.ts`](lib/ai/menuImport.ts), junto da
   sanitização (limites de categorias/produtos, preço `number`, nome
   normalizado) e do mapeamento de erros (`429` cota, `401` chave inválida,
   `400` arquivo ilegível);
3. **Revisão** — o modal mostra categorias e produtos em campos editáveis
   (nome, descrição e preço com máscara BRL via [`lib/currency.ts`](lib/currency.ts)),
   permite remover linhas e bloqueia o salvamento com nome/preço inválido;
4. **Gravação em lote** — `POST /api/ai/import-menu/save` reaproveita
   categorias do estabelecimento com o mesmo nome (comparação sem
   caixa/espaços), cria as demais com `position`/`sort_order` (detectado
   automaticamente conforme a migração aplicada) e insere os produtos na mesma
   coluna de ordenação, continuando a numeração existente. Se a inserção de
   produtos falhar, as categorias criadas na mesma chamada são removidas
   (rollback manual) e a API responde erro.

Variáveis de ambiente: `GEMINI_API_KEY` (secreta, só no servidor) e
`GEMINI_MODEL` (opcional, padrão `gemini-2.5-flash`). Sem a chave a rota
responde **500** com `"A variável de ambiente GEMINI_API_KEY não está
configurada no servidor."` — o cadastro manual continua funcionando normalmente.

> **Limites de hospedagem:** a rota declara `maxDuration = 60` porque a leitura
> do arquivo pode levar dezenas de segundos. O upload aceita até 10 MB
> (`MENU_IMPORT_MAX_BYTES`), mas plataformas serverless impõem teto próprio ao
> corpo da requisição (na Vercel, ~4,5 MB) — acima disso a importação falha
> antes de chegar ao código; nesse caso envie um PDF/foto menor.

## Sessão e cookies (`431 Request Header Fields Too Large`)

A sessão do Supabase vive em cookies **fatiados** (`sb-<ref>-auth-token.0`, `.1`, …).
Se pedaços antigos não forem apagados, o header `Cookie` cresce até passar do
limite de 16 KB do Node e **todas** as rotas passam a responder `431` — inclusive
o login, porque o servidor recusa a requisição antes de executar qualquer código.

O middleware (`lib/supabase/middleware.ts`) evita o problema:

- `setAll` **acumula** os cookies numa lista e reaplica em toda resposta criada
  na mesma requisição (a lib chama `setAll` mais de uma vez: PKCE + sessão);
- redirects (`/login`, `/confirmar-email`, `/auth/continuar`) também levam o
  `Set-Cookie` da sessão renovada;
- chunks órfãos (que a lib nunca lê) são apagados do browser;
- um aviso é registrado no log quando o header `Cookie` passa de 8 KB.

Se o `431` ainda aparecer (cookies poluídos **antes** desta correção), limpe os
cookies do domínio uma vez: o navegador nem envia a requisição, então o
middleware não tem como se auto-corrigir.

1. DevTools → **Application** → **Cookies** → `http://localhost:3000` →
   *Clear all* (ou **Application** → *Clear site data*);
2. recarregue e faça login novamente.

Em produção, o mesmo procedimento no domínio da loja. Um Nginx/CDN à frente do
app também tem limite próprio de headers (`large_client_header_buffers`).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
