# Webhook do Asaas — sincronização automática da assinatura

Endpoint: `POST /api/webhooks/asaas` (`app/api/webhooks/asaas/route.ts`).

Ele recebe as notificações do Asaas e atualiza `establishments.subscription_status`
e `establishments.trial_ends_at` (data de renovação) sem depender de o lojista
abrir o painel. Complementa o `GET /api/billing/status`, que reconcilia o estado
pelo polling da tela de assinatura.

## Regras aplicadas por evento

| Evento recebido | Ação no banco |
| --- | --- |
| `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED_IN_CASH` | `subscription_status = 'active'` e `trial_ends_at` = vencimento da cobrança (ou hoje) + 30 dias — a data só avança, nunca retrocede |
| `PAYMENT_OVERDUE` | Se o período pago/trial já venceu (`trial_ends_at <= agora`) → `past_due`; caso contrário nada muda |
| `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE` | `canceled` (o chargeback vencido pelo lojista volta a `active` no próximo `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`) |
| `PAYMENT_DUNNING_RECEIVED` | `past_due` (negativação em andamento) |
| `SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED` | `canceled` |
| Qualquer outro (`PAYMENT_CREATED`, `PAYMENT_DELETED`, …) | Nenhuma alteração; o evento é apenas confirmado |

## 1. Variável de ambiente

Em `.env.local` (e no provedor de deploy):

```bash
ASAAS_WEBHOOK_TOKEN=<token gerado no painel do Asaas>
```

- O valor precisa ser **igual** ao campo **Auth Token** do webhook no Asaas.
- Regras do Asaas: 32–255 caracteres, sem espaços, sem sequências simples e
  **nunca** a API Key da conta.
- Vazio/ausente → o endpoint responde **500** e recusa todos os eventos (falha
  fechada). Preencha antes de ativar o webhook no painel.

O Asaas envia o token no header `asaas-access-token`. O endpoint compara o valor
com `ASAAS_WEBHOOK_TOKEN` em tempo constante e devolve **401** quando o header
está ausente ou divergente.

## 2. Configurar no Sandbox

1. Acesse <https://sandbox.asaas.com> com a conta de testes.
2. Menu do usuário → **Integrações** → **Webhooks** → **Criar Webhook**.
3. Preencha:

| Campo | Valor |
| --- | --- |
| **Nome** | `Delivery — Assinaturas (sandbox)` |
| **URL** | `https://seu-dominio.com.br/api/webhooks/asaas` |
| **E-mail** | e-mail que deve receber alertas de falha de entrega |
| **API Version** | `v3` |
| **Auth Token** | clique em **Gerar token** e copie para `ASAAS_WEBHOOK_TOKEN` |
| **Enabled** | ativado |
| **Send Type** | envio sequencial (mantém a ordem dos eventos) |

4. Em **Eventos**, marque:

- `PAYMENT_RECEIVED`
- `PAYMENT_CONFIRMED`
- `PAYMENT_RECEIVED_IN_CASH`
- `PAYMENT_OVERDUE`
- `PAYMENT_REFUNDED`
- `PAYMENT_CHARGEBACK_REQUESTED`
- `PAYMENT_CHARGEBACK_DISPUTE`
- `PAYMENT_DUNNING_RECEIVED`
- `SUBSCRIPTION_DELETED`
- `SUBSCRIPTION_INACTIVATED`

5. Salve e confirme o webhook na lista.

> A URL é o domínio público da aplicação, **não** `localhost`. Cada conta pode ter
> até 10 webhooks; o Asaas envia `POST` com JSON e considera entregue ao receber
> **HTTP 200**.

## 3. Configurar em Produção

Repita os mesmos passos em <https://www.asaas.com> (menu do usuário →
**Integrações** → **Webhooks**) usando:

- **URL**: `https://seu-dominio.com.br/api/webhooks/asaas` (HTTPS obrigatório);
- **Auth Token**: um token **diferente** do Sandbox, também no `ASAAS_WEBHOOK_TOKEN`
  do ambiente de produção;
- os mesmos eventos da lista acima.

As configurações de Sandbox e Produção são independentes: um webhook criado no
Sandbox não recebe eventos reais e vice-versa.

## 4. Testar localmente

O Asaas só entrega em URL pública. Para testar com `npm run dev`:

```bash
# expõe a porta 3000 em uma URL https temporária
ngrok http 3000
```

Use a URL gerada (`https://<subdominio>.ngrok-free.app/api/webhooks/asaas`) no
webhook do Sandbox. Depois:

1. gere uma cobrança Pix/boleto em `/painel/assinatura` e pague no Sandbox;
2. acompanhe o `POST` no terminal do `next dev` (log `[webhook/asaas] …`);
3. confirme em `establishments` (`subscription_status`, `trial_ends_at`);
4. valide a entrega em **Integrações → Logs de Webhooks** no painel do Asaas.

## 5. Testar o endpoint sem o Asaas

```bash
TOKEN="<valor de ASAAS_WEBHOOK_TOKEN>"

# 401: header ausente
curl -i -X POST http://localhost:3000/api/webhooks/asaas \
  -H "Content-Type: application/json" \
  -d '{"event":"PAYMENT_RECEIVED"}'

# 200: evento de pagamento confirmado (troque o id por uma loja real)
curl -i -X POST http://localhost:3000/api/webhooks/asaas \
  -H "Content-Type: application/json" \
  -H "asaas-access-token: $TOKEN" \
  -d '{
    "id": "evt_teste_1",
    "event": "PAYMENT_RECEIVED",
    "payment": {
      "id": "pay_teste_1",
      "customer": "cus_000000000001",
      "subscription": "sub_teste_1",
      "status": "RECEIVED",
      "dueDate": "2026-11-10",
      "externalReference": "<id-da-loja>"
    }
  }'
```

Resposta esperada: `200 {"received":true}`. Reenviar o mesmo payload não altera
`trial_ends_at` (ver seção 7).

## 6. Como a loja é localizada

O endpoint tenta, nesta ordem, até encontrar uma loja:

1. `payment.externalReference` / `subscription.externalReference` → `establishments.id`
   (o checkout grava o id da loja como `externalReference` na assinatura);
2. `payment.subscription` / `subscription.id` → `establishments.subscription_id`;
3. `payment.customer` / `subscription.customer` → `establishments.customer_payment_id`.

Se nenhuma coluna corresponder, o evento é registrado no log
(`nenhuma loja vinculada`) e respondido com 200 — o Asaas não deve reenviar
indefinidamente um evento que não pertence a esta base.

## 7. Idempotência

O Asaas trabalha com entrega **at least once**: o mesmo `id` de evento pode ser
reenviado e `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` chegam para a mesma cobrança.

O endpoint é seguro para reenvios porque:

- o próximo estado é sempre **calculado** a partir do evento + estado atual;
- `trial_ends_at` é derivado do vencimento da cobrança com base em `00:00 UTC`
  (as duas notificações da mesma cobrança geram exatamente a mesma data);
- a data só é gravada quando é **maior** que a atual — reenvios não estendem o
  acesso;
- transições já aplicadas (ex.: `past_due` → `past_due`) não geram `UPDATE`.

## 8. Respostas HTTP

| Situação | Status | Corpo |
| --- | --- | --- |
| Evento processado, ignorado ou loja não encontrada | `200` | `{ "received": true }` |
| Header `asaas-access-token` ausente/divergente | `401` | `{ "error": "Token do webhook inválido." }` |
| `ASAAS_WEBHOOK_TOKEN` não configurado | `500` | `{ "error": "Webhook não configurado." }` |

Erros de banco não derrubam a resposta: ficam no log do servidor e são
reconciliados pelo `GET /api/billing/status` quando a loja abre a tela de
assinatura.

## 9. Checklist de validação

- [ ] `ASAAS_WEBHOOK_TOKEN` preenchido no ambiente (nunca commitado).
- [ ] Migração `20261110000012_add_subscriptions_to_establishments.sql` aplicada.
- [ ] Webhook criado no Sandbox com a URL `/api/webhooks/asaas` e os 10 eventos.
- [ ] Token do painel igual ao da variável de ambiente.
- [ ] `curl` sem header retorna 401; com header retorna `{"received":true}`.
- [ ] Pagamento Pix confirmado muda `subscription_status` para `active` e o
      painel libera o acesso sem recarregar manualmente.
- [ ] Logs de Webhooks no Asaas mostram `200` para as entregas.

## 10. Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| Asaas mostra `401` nos logs | `Auth Token` do painel diferente de `ASAAS_WEBHOOK_TOKEN` |
| Asaas mostra `500` | `ASAAS_WEBHOOK_TOKEN` vazio no ambiente |
| Asaas mostra `404`/`403` | URL errada, deploy ausente ou WAF/firewall bloqueando |
| `200` mas a loja não muda | `nenhuma loja vinculada` no log (loja criada fora do checkout) ou migração pendente |
| Loja muda para `canceled` sem motivo | evento de estorno/chargeback ou assinatura removida no Asaas |

Referências: [Receba eventos do Asaas](https://docs.asaas.com/docs/receba-eventos-do-asaas-no-seu-endpoint-de-webhook),
[Idempotência em Webhooks](https://docs.asaas.com/docs/como-implementar-idempotencia-em-webhooks),
[Eventos para cobranças](https://docs.asaas.com/docs/webhook-para-cobrancas),
[Eventos para assinaturas](https://docs.asaas.com/docs/eventos-para-assinaturas).
