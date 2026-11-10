# PIX Online no checkout (Split de Pagamentos — Etapa 2)

Documento da Etapa 2 da integração com o Asaas: geração da cobrança PIX com
Split, tela de pagamento na vitrine e confirmação automática por webhook.

## Visão geral

```
Cliente finaliza o pedido (payment_method = "pix_online")
        │
        ▼
POST /api/orders                → grava o pedido (payment_status = pendente,
        │                          customer_document = CPF/CNPJ do pagador)
        ▼
POST /api/asaas/pix-payment     → cria/reaproveita o cliente na SUBCONTA,
        │                          cria a cobrança PIX (POST /v3/payments)
        │                          com split R$ 0,50 → carteira da Ipepper
        ▼
Checkout exibe QR Code + Copia e Cola (cronômetro do QR)
        │
        ├── Asaas → POST /api/asaas/webhook (PAYMENT_CONFIRMED/RECEIVED)
        │             → orders.payment_status = 'pago'
        │             → UPDATE chega ao painel pelo Realtime (postgres_changes)
        │
        └── fallback: GET /api/asaas/pix-payment?order_id=...
                      (polling de 5s) concilia direto no gateway
```

## Regra do Split

- **Loja**: emite a cobrança dentro da própria subconta (credencial
  `establishments.asaas_api_key`), então o saldo restante fica com ela.
- **Ipepper**: recebe `fixedValue: 0.50` na carteira da conta principal
  (`ASAAS_PLATFORM_WALLET_ID`) — `PLATFORM_FEE_CENTS` em `lib/asaasSubaccount.ts`.
- O Asaas **recusa** Split para o `walletId` da própria conta emissora e valida
  a soma dos Splits sobre o `netValue` (valor menos as taxas do gateway). Por
  isso o split é só a taxa fixa e não é necessário calcular o restante.

## Variáveis de ambiente

| Variável | Obrigatória | Uso |
| --- | --- | --- |
| `ASAAS_API_KEY` | sim | Chave da conta principal (cria subcontas, webhooks e conciliação). |
| `ASAAS_PLATFORM_WALLET_ID` | sim (PIX Online) | `walletId` da carteira da Ipepper que recebe os R$ 0,50. Recupere em `GET /v3/wallets`. |
| `ASAAS_WEBHOOK_TOKEN` | sim | Mesmo token já usado por `/api/webhooks/asaas`; enviado no header `asaas-access-token`. |
| `ASAAS_API_URL` | não | Base da API. Padrão: sandbox (`https://sandbox.asaas.com/api/v3`). Em produção use `https://api.asaas.com/v3`. O `/v3` é completado quando a URL traz só o domínio. |
| `ASAAS_ENV` | não | Usada quando `ASAAS_API_URL` está vazia: `production`/`prod` aponta para `https://api.asaas.com/v3`; qualquer outro valor (ou vazio) mantém o sandbox. |
| `NEXT_PUBLIC_APP_URL` | não | Base do webhook registrado nas subcontas (`<url>/api/asaas/webhook`). Padrão `https://ipepper.com.br`. |

> A API key é **diferente** em sandbox e produção. Uma chave de produção
> chamada na base do sandbox (ou vice-versa) é recusada pelo gateway — confira
> `asaas_base_url` na resposta de erro antes de rotacionar a chave.

## Diagnóstico de 401/403 (integração recusada)

`POST /api/asaas/subaccount` (tela `/painel/configuracoes`) registra o corpo
detalhado do Asaas com `console.error` no servidor
(`[asaas] POST /accounts falhou (HTTP 403, Sandbox)`) e devolve o mesmo
diagnóstico no JSON:

| Campo | Conteúdo |
| --- | --- |
| `error` | Mensagem para o lojista; em 401/403 inclui as causas prováveis. |
| `code` | Código do erro do Asaas (ex.: `invalid_cpfCnpj`), quando existir. |
| `asaas_status` | HTTP devolvido pelo gateway (`400`, `401`, `403`…). |
| `asaas_environment` | `sandbox` ou `production`, inferido de `ASAAS_API_URL`/`ASAAS_ENV`. |
| `asaas_base_url` | Base efetivamente usada na chamada. |
| `asaas_request` | Método, endpoint e se a credencial era da subconta. |
| `details` | Corpo bruto do Asaas (`{ "errors": [{ "code", "description" }] }`); quando não é JSON, o trecho fica em `details.raw`. |

Interpretação do 403:

| Sintoma | Causa provável | Correção |
| --- | --- | --- |
| `details.raw` com HTML, sem `errors[]` | IP do servidor bloqueado (firewall/WAF do Asaas) | Libere o IP da hospedagem no painel do Asaas |
| `asaas_status: 401` com `code: invalid_access_token` | API key inválida, revogada ou de outro ambiente | Gere a chave no ambiente de `asaas_base_url` e atualize `ASAAS_API_KEY` |
| 403 ao alternar para produção | Chave de produção apontando para o sandbox (ou vice-versa) | Alinhe `ASAAS_API_KEY` × `ASAAS_API_URL`/`ASAAS_ENV` |
| `errors[0].description` citando permissão/subconta | Conta principal sem permissão para criar subcontas | Habilite subcontas na conta-mãe do Asaas |

## Migrações

1. `20261110000027_add_asaas_subaccount_to_establishments.sql` (Etapa 1);
2. `20261110000028_add_asaas_pix_online_payments.sql`:
   - `establishments.asaas_api_key` — credencial da subconta (sensível, nunca
     retorna ao navegador);
   - `orders.asaas_payment_id`, `orders.payment_status`,
     `orders.payment_confirmed_at`, `orders.customer_document`,
     `orders.pix_payload`, `orders.pix_expiration` + índices.

## Webhook

- URL: `https://<domínio>/api/asaas/webhook`.
- É registrado automaticamente na subconta ao salvar o recebimento online
  (`ensureAsaasWebhook`, best-effort, sem duplicar URL existente).
- Para a conta principal ele pode ser cadastrado manualmente no painel do
  Asaas (não afeta as assinaturas, que continuam em `/api/webhooks/asaas`).
- Eventos tratados: `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` e
  `PAYMENT_RECEIVED_IN_CASH`. Os demais respondem `200 { received: true }`.
- Vínculo com o pedido: `payment.externalReference` (id do pedido) e, como
  fallback, `payment.id` → `orders.asaas_payment_id`.
- Idempotente: reenvios não regravam o pedido (`markOrderPaid` só atualiza
  enquanto `payment_status <> 'pago'`).

## Fluxo na vitrine

1. `/api/menu` só devolve `accept_pix_online: true` quando a loja tem
   `accept_pix_online`, `asaas_account_id` e `asaas_api_key`.
2. O checkout mostra a opção **PIX Online** e exige CPF/CNPJ do pagador.
3. `POST /api/orders` valida a elegibilidade e grava o documento.
4. A tela de pagamento (`PixPaymentDialog`) mostra QR Code, botão
   "Copiar chave PIX", cronômetro e o status "Aguardando pagamento...".
5. Ao confirmar: redireciona para `/pedido/[id]` (que também reexibe o Copia e
   Cola enquanto pendente e mostra "Pagamento confirmado" após o webhook).
6. O card do Kanban recebe "✓ PIX pago" pelo Realtime/polling do painel.

## Extrato de Pagamentos (`/painel/financeiro`)

Tela do lojista com o financeiro dos pedidos pagos online:

- **Cards do mês corrente** (fuso da loja): total vendido online, taxas da
  plataforma (`R$ 0,50` × pedidos pagos — `PLATFORM_FEE_CENTS`) e saldo líquido
  repassado para a subconta.
- **Tabela** com pedido (`#0001…`), data/hora, cliente, valor bruto, taxa,
  líquido, situação do pagamento (`Pago ✓`, `Pendente ⏳`, `Expirado`,
  `Cancelado`) e situação do repasse.
- **Filtros** Todos / Pagos / Pendentes; pedidos não pagos aparecem com taxa e
  líquido como “—” (nada foi retido nem repassado).

Dados: `GET /api/financeiro?establishment_id=…` (`requireMenuAccess` +
`canManageEstablishment`) lê `orders` filtrando `payment_method = 'pix_online'`
ou `asaas_payment_id` preenchido, pagina de 1000 em 1000 e recalcula tudo no
servidor. Se o filtro do PostgREST falhar (base sem a migração
20261110000028), a rota cai para a leitura completa e classifica em memória.
Contrato, rótulos e cores compartilhados entre API e UI ficam em
[`lib/finance.ts`](../lib/finance.ts).

## Tela de configuração do recebimento (`/painel/configuracoes`)

Seção **Pagamento Online / Financeiro** do painel da loja:

- **Badge de situação ao lado do título** — `resolveOnlinePaymentStatus`
  ([`lib/asaasSubaccount.ts`](../lib/asaasSubaccount.ts)) combina
  `establishments.asaas_account_id` com o toggle "Aceitar PIX Online":
  - 🟢 **Ativo / Conectado** — subconta criada e PIX ligado no cardápio;
  - 🟡 **Conectado · PIX desativado** — subconta pronta, checkout sem PIX;
  - ⚪ **Inativo / Não conectado** — nenhuma subconta criada.

  O badge e a linha de apoio abaixo do título reagem na hora ao toggle (mesmo
  antes de salvar), então o estado fica visível sem rolar a página.
- **Pré-preenchimento** — `buildSubaccountFormFromRow` abre o formulário com o
  que o cadastro da loja já tem: razão social (`owner_name`, ou `name`),
  `document_number`, `email`, telefone (`phone` e, quando vazio, `whatsapp`) e
  `store_cep`. O snapshot `asaas_subaccount` tem prioridade, então nada é
  sobrescrito em lojas já conectadas; o lojista só revisa/edita.
- **Endereço pelo CEP** — `establishments` não guarda rua/número/bairro, então
  logradouro e bairro são completados por `GET /api/geocode?cep=…`
  (BrasilAPI/ViaCEP) ao abrir a seção e ao digitar os 8 dígitos do CEP; o botão
  **Buscar endereço pelo CEP** força uma nova consulta. O preenchimento só ocupa
  campos vazios (nunca sobrescreve edição do lojista) e o número continua
  manual — a consulta de CEP não devolve número.

## Segurança

- `asaas_api_key` é lida apenas em rotas server-side (service role) e **nunca**
  é devolvida por `/api/menu`, `/api/asaas/subaccount` (GET/POST) ou para o
  navegador. Restrinja o acesso ao banco e rotacione a chave no Asaas se
  houver vazamento.
- O webhook falha fechado sem `ASAAS_WEBHOOK_TOKEN` e compara o token em tempo
  constante.
- `/api/asaas/pix-payment` é público como `/api/order-status`: o uuid do pedido
  funciona como token. A rota é idempotente (reaproveita a cobrança aberta) e
  nunca aceita valores do navegador — usa `orders.total`.

## Teste rápido (Sandbox)

```bash
# 1) token do webhook
TOKEN="<valor de ASAAS_WEBHOOK_TOKEN>"

# 2) simular confirmação de uma cobrança já criada
curl -i -X POST http://localhost:3000/api/asaas/webhook \
  -H "Content-Type: application/json" \
  -H "asaas-access-token: $TOKEN" \
  -d '{
    "id": "evt_pix_1",
    "event": "PAYMENT_CONFIRMED",
    "payment": {
      "id": "<id-da-cobranca>",
      "status": "CONFIRMED",
      "externalReference": "<id-do-pedido>"
    }
  }'
```

Resultado esperado: `200 {"received":true}` e `orders.payment_status = 'pago'`.
