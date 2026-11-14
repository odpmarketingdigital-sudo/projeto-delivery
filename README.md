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

### Horário de fechamento no selo e pedido mínimo

- O selo verde da vitrine mostra o fechamento do **turno atual** quando a loja
  está aberta e existe horário configurado: `ABERTO AGORA • Fecha às 23:00`
  ([`getCurrentClosingTime`](lib/openingHours.ts)). Loja sem horários (abertura
  manual) ou dia marcado como 24h mantêm apenas `ABERTO AGORA`; o cálculo só
  roda depois da montagem, pela mesma regra de hidratação do `storeStatus`;
- `establishments.min_order_value` (migração
  `20261111000003_add_min_order_value_to_establishments.sql`) define o pedido
  mínimo da loja, comparado com o **subtotal dos itens** (sem a taxa de entrega).
  O valor é editado em `/painel/configuracoes` (seção "Pedido mínimo", `0,00` =
  sem mínimo) e usado em três pontos:
  - vitrine e barra da sacola: texto discreto `Pedido mínimo: R$ 25,00`;
  - [`CartDrawer`](app/components/CartDrawer.tsx) e
    [`CheckoutForm`](app/components/CheckoutForm.tsx): a mensagem
    [`describeMinOrderShortfall`](lib/minOrder.ts) informa o mínimo e quanto
    falta, e o botão de avançar/confirmar fica desabilitado;
  - `POST /api/orders`: revalidação no servidor (400 com a mesma mensagem).
  Itens "Sob Consulta" (modo catálogo) ficam fora da regra — o valor é
  combinado com o atendente.

### Vale-Refeição / Alimentação na entrega

- `establishments.accepted_meal_vouchers` (jsonb, migração
  `20261111000004_add_meal_vouchers.sql`) guarda as bandeiras que a loja aceita
  cobrar **presencialmente na entrega** (maquininha): `Alelo`,
  `Sodexo / Pluxee`, `Ticket`, `VR Benefícios`, `Ben Visa Vale`, `Greencard`,
  `Verocard` e bandeiras customizadas. O cadastro fica em
  `/painel/configuracoes` (seção "Vale-Refeição / Alimentação (Pagamento na
  entrega)") e é salvo por `PUT /api/establishment` com fallback seguro quando a
  coluna ainda não existe (resposta com `warning`, sem derrubar o restante);
- `/api/menu` devolve a lista normalizada em
  `StorefrontInfo.accepted_meal_vouchers`; o checkout
  ([`CheckoutForm`](app/components/CheckoutForm.tsx)) só mostra a opção
  "Vale-Refeição / Alimentação" quando há pelo menos uma bandeira e exige a
  escolha da bandeira antes de confirmar;
- A modalidade é **100% presencial**: não aciona gateway online/PIX Asaas. O
  pedido é gravado com `payment_method = 'vale_refeicao'` e
  `orders.meal_voucher` (migração 20261111000004); `POST /api/orders` revalida a
  bandeira contra a lista da loja (400 quando não aceita);
- O resumo do WhatsApp ([`lib/whatsappOrder.ts`](lib/whatsappOrder.ts)), o card
  do `/painel` ([`OrderCard`](app/components/OrderCard.tsx)), o modal de detalhes,
  o acompanhamento (`/pedido/[id]`) e "Meus Pedidos" (`/[slug]/pedidos`) exibem
  `Vale-Refeição (Alelo) - na entrega` (rótulo único em
  [`lib/paymentLabels.ts`](lib/paymentLabels.ts)), para o entregador levar a
  maquininha correta;
- Base sem a coluna `orders.meal_voucher`: o pedido continua sendo gravado e a
  bandeira é anexada às observações, sem perder a informação.

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
- O carrinho, o CEP/endereço de entrega e o endereço do checkout usam
  `useSyncExternalStore` com `getServerSnapshot` vazio, então SSR e hidratação
  sempre concordam (o valor real entra no render seguinte);
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
- A coluna `establishments.direct_whatsapp_checkout` (migração
  `20261110000017_add_direct_whatsapp_checkout.sql`) guarda a preferência da
  loja, mas **não é exibida no painel do lojista** (`/painel/configuracoes`).
  Ela continua sendo lida/gravada pela API e honorada pela sacola/checkout; sem
  a liberação acima, `PUT /api/establishment` recusa
  `direct_whatsapp_checkout: true` com 403;
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

1. **Busca automática de endereço (sem campo de CEP)** — o campo *Rua* do
   checkout ([`AddressAutocomplete.tsx`](app/components/AddressAutocomplete.tsx))
   usa a Google Maps JS API (Places) para sugerir endereços no Brasil. Ao escolher
   uma sugestão, o formulário recebe **rua, número, bairro, cidade, estado** e as
   **coordenadas** (`lat`/`lng`), que seguem no corpo do pedido. O **CEP não é
   mais digitado pelo cliente**: quando o Google devolve o CEP ele é usado apenas
   como dado interno do endereço (nunca como campo de formulário). O mesmo vale
   para a sacola, que também só oferece a busca por endereço;
2. **Cotação no servidor** — `POST /api/delivery-quote` (pré-visualização) e
   `POST /api/orders` (validação final) chamam a mesma função
   [`quoteDelivery`](lib/deliveryQuote.ts), que:
   - usa as coordenadas do Places quando existem; na falta delas, geocodifica o
     endereço digitado (rua/número/bairro/cidade) em
     [`lib/cep.ts`](lib/cep.ts) (`geocodeAddressParts` → Nominatim) e, se houver
     CEP, cai para a consulta de CEP (BrasilAPI → ViaCEP → Nominatim);
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
   `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` o campo de rua vira um input comum e a
   cotação passa a usar a geocodificação do endereço digitado no servidor.
5. **Checkout pré-preenchido** — o endereço usado na sacola (e o telefone/nome do
   perfil salvo no navegador) chega pronto ao checkout
   ([`context/CartContext.tsx`](context/CartContext.tsx),
   `deliveryAddress`, e [`lib/storage.ts`](lib/storage.ts)): o cliente só revisa
   ou altera o que quiser antes de finalizar.

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
   Gemini (`@google/genai`, padrão `gemini-3.8-flash`) via `inlineData` com
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
`GEMINI_MODEL` (opcional, padrão `gemini-3.8-flash`). Sem a chave a rota
responde **500** com `"A variável de ambiente GEMINI_API_KEY não está
configurada no servidor."` — o cadastro manual continua funcionando normalmente.

> **Limites de hospedagem:** a rota declara `maxDuration = 60` porque a leitura
> do arquivo pode levar dezenas de segundos. O upload aceita até 10 MB
> (`MENU_IMPORT_MAX_BYTES`), mas plataformas serverless impõem teto próprio ao
> corpo da requisição (na Vercel, ~4,5 MB) — acima disso a importação falha
> antes de chegar ao código; nesse caso envie um PDF/foto menor.

## Arquitetura de permissões: Superadmin × Estabelecimento

O painel é dividido em dois mundos com fronteiras explícitas. A regra é simples:
**o global é da plataforma, o operacional é da loja.**

| Área | Superadmin (`/painel/admin/...`) | Estabelecimento (`/painel/...`) |
| --- | --- | --- |
| Chaves de API (`GEMINI_API_KEY`, `EVOLUTION_API_*`, `WHATSAPP_WEBHOOK_TOKEN`) | Vê **apenas o status** (configurada/ausente) em `/painel/admin/ia`; os valores ficam só nas variáveis de ambiente do servidor | Não vê nada |
| Prompt mestre do atendimento | Edita em `/painel/admin/ia` → `system_settings.ai_master_prompt` | Não vê (aplica-se a todas as lojas) |
| Tom de voz da IA | Define o padrão global (`ai_default_personality`) | Não vê (aplicado pelo servidor em todas as respostas) |
| Cadeia de modelos Gemini | Edita (`ai_models`); vazio = `GEMINI_MODEL`/`GEMINI_MODEL_FALLBACKS` | Não vê |
| Conexão do WhatsApp (Evolution) e QR Code | Conecta/desconecta qualquer loja em `/painel/admin/ia` (`POST /api/whatsapp-ia`) | Conecta e desconecta o **próprio** número em `/painel/whatsapp-ia`: **Conectar WhatsApp** (gera o QR Code na tela) e **Desconectar WhatsApp** (encerra a sessão para conectar outro número) |
| Nome do atendente, IA ligada/desligada e observações da loja | Edita por loja em `/painel/admin/ia` → **Configurar IA** (`PUT /api/whatsapp-ia`) | Não vê nenhum campo de configuração |
| Histórico de conversas do WhatsApp | Não existe em nenhuma tela | Não existe: o sistema **não persiste mensagens** e a IA atende sozinha no número conectado |
| Nome, horário, entrega, pedido mínimo, vale-refeição, cardápio, imagens | — | Edita em `/painel/configuracoes`, `/painel/produtos` |

Endpoints e suas permissões:

- `GET/PUT /api/admin/ai-settings` — **só Superadmin** (`requireSuperAdmin`):
  prompt mestre, tom de voz, prefixo de instância, modelos, status das
  integrações e a lista de lojas/instâncias (com nome do atendente e observações
  de cada loja).
  `POST { action: "ensure_instances" }` gera o nome das instâncias que faltam no
  padrão `<prefixo>-<slug>`.
- `GET /api/whatsapp-ia` — dono da loja **ou** Superadmin, somente leitura do
  estado (conexão + metadados). `whatsapp_instance_name` volta como `null` para
  quem não é Superadmin.
- `PUT /api/whatsapp-ia` — **só Superadmin**: `ai_enabled`,
  `ai_assistant_name`, `ai_personality`, `ai_custom_instructions` e
  `whatsapp_instance_name`. O lojista não tem mais nenhum campo de configuração
  no painel e qualquer `PUT` dele responde `403`.
- `POST /api/whatsapp-ia` (`connect`/`status`/`disconnect`) — dono da loja **ou**
  Superadmin: é a conexão do próprio número (QR Code) e o encerramento da sessão
  (`DELETE /instance/logout/{instance}`, com `DELETE /instance/delete/{instance}`
  apenas para limpar instâncias órfãs). O campo `instance_name` só é aceito do
  Superadmin — o nome da instância é derivado de `<prefixo>-<slug>`.
- `POST /api/webhooks/whatsapp` — máquina (Evolution API), autenticada por
  `WHATSAPP_WEBHOOK_TOKEN`.

### Como o prompt é montado

O prompt do modelo é montado no servidor, em camadas, sempre nesta ordem de
prioridade (ver [`buildWhatsappSystemPrompt`](lib/ai/whatsappAgent.ts)):

1. **Prompt mestre da plataforma** (`system_settings.ai_master_prompt`, editável
   só pelo Superadmin; padrão de fábrica em `DEFAULT_AI_MASTER_PROMPT`);
2. **tom de voz global** (`ai_default_personality`);
3. **observações operacionais da loja** (`establishments.ai_custom_instructions`,
   cadastradas pelo Superadmin em **Configurar IA** a partir do que a loja informa)
   — marcadas no prompt como subordinadas às regras da plataforma;
4. dados reais da loja (horário calculado na hora, pedido mínimo, entrega,
   vale-refeição, contato);
5. cardápio atual (categorias e produtos ativos).

Nenhum parâmetro técnico (modelo, chave, instância, webhook) entra no prompt, e
o texto final reforça que o atendente **nunca** deve revelar regras internas,
modelos, chaves ou detalhes da plataforma ao cliente final.

## Atendente virtual de WhatsApp (Evolution API + Gemini)


Em **Painel → WhatsApp** a loja faz uma coisa só: conecta o número que atende os
clientes. A IA conduz o atendimento de forma autônoma nesse número, com base no
cardápio, nos dados da loja e nas observações livres (`ai_custom_instructions`),
e o painel do lojista **não tem histórico de conversas nem campo de resposta** —
o sistema não grava nenhuma mensagem. Tudo que é configuração — prompt mestre,
tom de voz, modelos, nome do atendente, IA ligada/desligada e as observações da
loja — é definido pelo Superadmin em **Painel SaaS → Atendente IA**. O fluxo:

1. **Conexão do número** — `POST /api/whatsapp-ia` com
   `{ establishment_id, action: "connect" }`, chamado pela loja em
   `/painel/whatsapp-ia` (**Conectar WhatsApp**) ou pelo Superadmin em
   `/painel/admin/ia`, cria a instância na Evolution API (`POST /instance/create`,
   com `integration: "WHATSAPP-BAILEYS"` e o webhook já apontando para
   `/api/webhooks/whatsapp`; `403`/`409` = instância já existente) e só então
   consulta `GET /instance/connect/{instance}` para devolver o QR Code. O nome da
   instância vem do corpo (opcional), do banco ou é derivado de
   `whatsapp_instance_prefix` + slug da loja. O QR é lido com o celular da loja e
   `{ action: "status" }` atualiza `establishments.whatsapp_connected`. Para
   trocar de aparelho, `{ action: "disconnect" }` executa
   `DELETE /instance/logout/{instance}` (nome da instância no **path**, chave no
   header `apikey` e **sem body**), grava `whatsapp_connected = false` e libera
   um novo QR Code no próximo `connect`. A v2 responde `400` com
   `{"status":400,"error":"Bad Request","message":["The \"<instance>\" instance
   is not connected"]}` quando a sessão já caiu no celular: esse caso é tratado
   como sucesso (`already_disconnected: true`) e o estado é limpo no banco do
   mesmo jeito. Instância que não existe mais (`404`) é limpa com
   `DELETE /instance/delete/{instance}`;
2. **Mensagens recebidas** — a Evolution envia `messages.upsert` para
   `POST /api/webhooks/whatsapp` (token em `WHATSAPP_WEBHOOK_TOKEN`, header
   `x-webhook-token`). A rota localiza a loja pelo nome da instância e responde
   pelo Gemini ([`lib/ai/whatsappAgent.ts`](lib/ai/whatsappAgent.ts)) **sem
   gravar a mensagem no banco**;
3. **Pausa automática** — quando alguém da loja responde pelo aplicativo
   (`fromMe`), a IA fica pausada por `AI_PAUSE_MINUTES` (30 min) para aquele
   telefone. Sem resposta humana a IA volta sozinha;
4. **Sem histórico** — não existe tabela de conversas/mensagens, endpoint de
   chat nem tela de atendimento. O contexto de curto prazo (últimos turnos) e as
   pausas vivem apenas na memória do processo do servidor
   ([`lib/whatsapp/conversationMemory.ts`](lib/whatsapp/conversationMemory.ts)):
   reiniciar o processo zera o contexto e, com várias instâncias do servidor,
   cada uma mantém a própria memória. Nenhum conteúdo de mensagem é persistido;

As regras compartilhadas (personalidades, normalização de telefone/instância,
limites de texto e duração da pausa) ficam em
[`lib/whatsappAssistant.ts`](lib/whatsappAssistant.ts).

Variáveis de ambiente (ver [`.env.local.example`](.env.local.example)):
`GEMINI_API_KEY` + `GEMINI_MODEL` (opcional, padrão `gemini-3.8-flash`) e
`EVOLUTION_API_URL`,
`EVOLUTION_API_KEY`, `WHATSAPP_WEBHOOK_TOKEN` e `WHATSAPP_WEBHOOK_URL`
(opcional: sem ela usa `NEXT_PUBLIC_APP_URL` + `/api/webhooks/whatsapp`). Sem as
variáveis da Evolution a IA continua sendo chamada, mas nenhuma resposta é
enviada — o texto fica no log estruturado do webhook.

> **Alta demanda / modelo desligado:** o atendente usa a cadeia de
> [`resolveWhatsappAiModels`](lib/ai/whatsappAgent.ts) — o modelo principal
> (`GEMINI_MODEL`) seguido de `GEMINI_MODEL_FALLBACKS` (padrão
> `gemini-3.6-flash,gemini-3.5-flash-lite`). Falhas temporárias (`429` limite,
> `503` sobrecarga, `404` modelo inexistente e erro de rede) repetem a chamada
> uma vez com backoff exponencial e depois passam para o próximo modelo; erro de
> chave (`ai_auth_failed`) ou resposta vazia (`empty_reply`) não é repetido. Cada
> tentativa fica no log com o código e o modelo.
>
> Modelos **não** use: `gemini-1.5-flash` (desligado em 2025) e
> `gemini-2.0-flash` (desligado em 01/06/2026) — a API responde `404` e o
> atendimento fica sem resposta. O substituto atual é `gemini-3.8-flash`.

Migração: `20261111000005_add_ai_whatsapp_assistant.sql` (colunas de IA em
`establishments`). Sem ela o painel abre com o aviso de migração pendente.

Migração de limpeza: `20261113000002_drop_whatsapp_chat_history.sql` remove
`whatsapp_messages` e `whatsapp_conversations` de bancos que ainda tinham o
histórico antigo (idempotente; as colunas de IA da loja são preservadas).

Migração da configuração global: `20261112000002_add_global_ai_settings.sql`
(seed de `ai_default_personality` e `whatsapp_instance_prefix`, comentários das
colunas e RLS defensiva em `system_settings`). O prompt mestre **não** é seedado:
enquanto não for salvo em `/painel/admin/ia`, vale `DEFAULT_AI_MASTER_PROMPT` de
[`lib/whatsappAssistant.ts`](lib/whatsappAssistant.ts) — uma única cópia do
texto, sem risco de divergência entre SQL e TypeScript.

### Notificações automáticas de pedidos

O ciclo do pedido fala com os dois lados pelo WhatsApp
([`lib/whatsapp/orderNotifications.ts`](lib/whatsapp/orderNotifications.ts)):

| Evento | Quando dispara | Quem recebe |
| --- | --- | --- |
| **Novo pedido** | `POST /api/orders` grava o pedido | Loja (`establishments.whatsapp`, fallback `phone`) |
| **Pedido aceito** | `PUT /api/orders` com `action: "accept"` (botão **Aceitar pedido**) | Cliente (`orders.customer_phone`) |
| **Mudança de etapa** | `PUT /api/orders` com status diferente do atual | Cliente (`orders.customer_phone`) |

- **O cliente não recebe nada na criação do pedido.** A confirmação
  ("pedido recebido/confirmado") é disparada **somente** quando o lojista clica
  em **Aceitar pedido** — botão presente nos cards pendentes do Kanban, na
  visão em lista e no modal de detalhes. A ação envia `action: "accept"` para
  `PUT /api/orders`, que valida que o pedido ainda está `pendente` (repetir a
  ação responde `409`), muda o status para `preparando` e só então notifica o
  cliente.
- **Remetente é sempre a instância da loja**
  (`establishments.whatsapp_instance_name`): a Evolution API só entrega mensagens
  de um número conectado. Loja sem instância ou sem número de destino não gera
  envio — a rota do pedido segue normalmente.
- **Resumo do novo pedido** reaproveita
  [`buildOrderWhatsAppMessage`](lib/whatsappOrder.ts): número do pedido, itens com
  adicionais e observações, total, forma de pagamento (com troco/vale) e endereço
  completo. Pedidos de **retirada** (`orders.delivery_type = 'retirada'`) nunca
  mostram endereço: o bloco vira **Retirada no balcão do estabelecimento** e a
  taxa aparece como "sem taxa".
- **Mensagens por etapa** (`buildCustomerStatusMessage`), sempre com o primeiro
  nome do cliente e o código curto do pedido: `preparando` (confirmado e em
  preparo, com a previsão), `entrega` (**"saiu para entrega"** no delivery e
  **"pronto para buscar no balcão"** na retirada), `finalizado` (bom apetite) e
  `cancelado` (com o motivo informado pelo painel). `pendente` só é
  enviado se o pedido voltar manualmente para essa etapa. Aliases de borda
  (`em_preparo`, `confirmado`, `saiu_para_entrega`, `concluido`, `entregue`) são
  normalizados antes de escolher o texto.
- **Anti-duplicação:** o `PUT` só notifica quando o status realmente muda —
  regravar o mesmo status (ex.: só ajustar a previsão de entrega) não reenvia.
- **O pedido nunca depende do WhatsApp:** o envio acontece depois do
  `insert`/`update` e dentro de `try/catch`; falhas viram log
  (`[whatsapp:pedido] ...`), com timeout próprio de 6 s
  (`ORDER_NOTIFICATION_TIMEOUT_MS`) para não segurar o checkout. Erros não são
  reprocessados automaticamente.
- **Número igual ao da instância:** se a loja cadastrar em
  `establishments.whatsapp` o mesmo número conectado à instância, a mensagem cai
  na conversa "Você" do próprio WhatsApp — comportamento esperado.

## Entrega x retirada e confirmação de recebimento

O checkout (e a sacola) pergunta **como o cliente quer receber** o pedido:

| Modalidade | Endereço | Taxa | Etapa final |
| --- | --- | --- | --- |
| `entrega` | obrigatório (rua, número e bairro) | calculada pela loja | **Saiu para Entrega** |
| `retirada` | dispensado (só nome + telefone) | zero | **Pronto para buscar** |

- A escolha fica em `@delivery:order-type` (localStorage) via `CartContext`
  (`orderType`/`setOrderType`) e chega pré-marcada no checkout. O corpo de
  `POST /api/orders` leva `order_type`; o servidor grava
  `orders.delivery_type` (migração
  `20261113000001_add_delivery_type_to_orders.sql`), **não** cobra taxa e
  **não** exige endereço quando a modalidade é `retirada`. O `delivery_type`
  também é aceito como alias do campo para integrações externas.
- Pedidos antigos (sem a coluna) continuam classificados pela presença de
  endereço — a mesma regra histórica do painel, centralizada em
  `orderDeliveryType` ([`lib/orderStatus.ts`](lib/orderStatus.ts)).
- **Rótulos por modalidade:** `orderStatusLabel(status, deliveryType)` troca
  "Saiu para Entrega" por **"Pronto para buscar"** nos cards do Kanban, na
  visão em lista, no modal de detalhes, na página `/pedido/[id]`, em
  `/[slug]/pedidos` e nas mensagens automáticas do WhatsApp. O card mostra um
  selo **🛵 Entrega** / **🛍️ Retirada** e o botão de avanço em `preparando`
  vira "Marcar pronto". A coluna final do Kanban exibe a nota
  "Retirada: pronto para buscar".
- **"Recebi o pedido":** na tela `/pedido/[id]`, quando o pedido está em
  `entrega`, o cliente confirma o recebimento em
  `POST /api/orders/received`. A rota é pública, valida o UUID **e** o telefone
  do pedido (mesmo modelo de `POST /api/orders/cancel`) e só aceita essa etapa;
  o status vira `finalizado`, encerrando o ciclo do pedido. Na retirada o botão
  aparece como **"Já retirei o pedido"**.
- Sem telefone salvo no navegador, o clique abre um diálogo pedindo o WhatsApp
  usado no pedido (prova de posse); com o telefone salvo, a confirmação é
  imediata (1 clique).
- A base sem a migração continua funcionando: o `insert` de `POST /api/orders`
  repete sem `delivery_type` quando a coluna não existe (o painel volta a
  inferir pelo endereço).

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
