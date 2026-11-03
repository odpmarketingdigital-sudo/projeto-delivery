/**
 * POST /api/webhooks/asaas — mantém a assinatura da loja sincronizada com o
 * Asaas sem depender de o usuário abrir o painel.
 *
 * Segurança:
 *  - o Asaas envia o token configurado no painel no header
 *    `asaas-access-token`, comparado em tempo constante com
 *    `ASAAS_WEBHOOK_TOKEN`. Header ausente/divergente → 401;
 *  - com `ASAAS_WEBHOOK_TOKEN` vazio o endpoint falha fechado (500): nenhum
 *    evento é aceito enquanto o webhook não estiver configurado.
 *
 * Vínculo com a loja (nesta ordem):
 *  1. `externalReference` — o checkout grava o id da loja na assinatura;
 *  2. `subscription_id`   — id da assinatura no Asaas;
 *  3. `customer_payment_id` — id do cliente no Asaas.
 *
 * Idempotência: o Asaas entrega eventos "at least once" (o mesmo `id` pode ser
 * reenviado e `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` chegam para a mesma
 * cobrança). Por isso o próximo estado é sempre CALCULADO a partir do evento e
 * do estado atual — nunca incrementado — e `trial_ends_at` só avança quando a
 * nova data é maior. Reenvios não estendem o acesso.
 *
 * Resposta: 200 `{ received: true }` em todos os casos autenticados (inclusive
 * evento desconhecido ou loja não encontrada), como o Asaas espera. Falhas de
 * banco ficam registradas no log e são reconciliadas pelo
 * `GET /api/billing/status` (consultado pela tela de assinatura).
 *
 * Docs: https://docs.asaas.com/docs/receba-eventos-do-asaas-no-seu-endpoint-de-webhook
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { toDateOnly } from "@/lib/storeEligibility";
import {
  revalidatePublicStore,
  restoreStoreAfterPayment,
} from "@/lib/storeAvailability";
import { createAdminClient } from "@/lib/supabase/server";
import {
  addTrialDays,
  todayDateOnly,
  TRIAL_DAYS,
  type SubscriptionStatus,
} from "@/lib/subscriptions";

/**
 * Colunas de assinatura (migração 20261110000012) + cobrança
 * (20261110000023). Bases sem a migração de cobrança recuam para
 * `BASE_ESTABLISHMENT_COLUMNS`.
 */
const ESTABLISHMENT_COLUMNS =
  "id, subscription_status, trial_ends_at, subscription_id, customer_payment_id, payment_due_date, payment_invoice_url, last_payment_at";

/** Colunas mínimas (bases anteriores à migração 20261110000023). */
const BASE_ESTABLISHMENT_COLUMNS =
  "id, subscription_status, trial_ends_at, subscription_id, customer_payment_id";

/** Linha lida de `establishments`. */
interface EstablishmentRow {
  id: string;
  subscription_status: SubscriptionStatus | null;
  trial_ends_at: string | null;
  subscription_id: string | null;
  customer_payment_id: string | null;
  /** Vencimento da cobrança em aberto (migração 20261110000023). */
  payment_due_date?: string | null;
  /** Link da fatura no Asaas (banner de regularização do painel). */
  payment_invoice_url?: string | null;
  /** Momento do último pagamento recebido. */
  last_payment_at?: string | null;
}

/** Cobrança embutida no payload do webhook (só os campos usados). */
interface AsaasWebhookPayment {
  id?: string;
  customer?: string;
  subscription?: string | null;
  status?: string;
  billingType?: string;
  dueDate?: string;
  externalReference?: string | null;
  /** Link da fatura no Asaas (usado pelo banner de regularização). */
  invoiceUrl?: string | null;
  /** Datas de confirmação/recebimento (podem vir só com `YYYY-MM-DD`). */
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
}

/** Assinatura embutida no payload (eventos `SUBSCRIPTION_*`). */
interface AsaasWebhookSubscription {
  id?: string;
  customer?: string;
  status?: string;
  nextDueDate?: string;
  externalReference?: string | null;
}

/** Payload enviado pelo Asaas. Campos novos são ignorados com segurança. */
interface AsaasWebhookPayload {
  id?: string;
  event?: string;
  payment?: AsaasWebhookPayment | null;
  subscription?: AsaasWebhookSubscription | null;
}

/** Cobrança paga: Pix/boleto compensado, cartão capturado ou dinheiro. */
const PAID_EVENTS = new Set<string>([
  "PAYMENT_RECEIVED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED_IN_CASH",
]);

/** Estorno/chargeback: o dinheiro voltou (ou está em disputa). */
const REFUND_EVENTS = new Set<string>([
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
]);

/** Assinatura encerrada no painel do Asaas. */
const SUBSCRIPTION_END_EVENTS = new Set<string>([
  "SUBSCRIPTION_DELETED",
  "SUBSCRIPTION_INACTIVATED",
]);

/** Eventos que mudam o estado da loja (os demais são apenas confirmados). */
const HANDLED_EVENTS = new Set<string>([
  ...PAID_EVENTS,
  ...REFUND_EVENTS,
  ...SUBSCRIPTION_END_EVENTS,
  "PAYMENT_OVERDUE",
  "PAYMENT_DUNNING_RECEIVED",
  "PAYMENT_DELETED",
]);

/** Coluna usada para localizar a loja a partir do evento. */
type LookupColumn = "id" | "subscription_id" | "customer_payment_id";

interface EstablishmentLookup {
  column: LookupColumn;
  value: string;
}

/** Resultado da busca da loja (evita lançar erro para o Asaas). */
type LookupResult =
  | { status: "found"; row: EstablishmentRow }
  | { status: "missing" }
  | { status: "schema-pending" }
  | { status: "error"; message: string };

/** Estado a persistir depois do evento. */
interface NextState {
  subscriptionStatus: SubscriptionStatus;
  /** Nova data de renovação (ISO), quando o evento é de pagamento. */
  trialEndsAt?: string;
  /**
   * Vencimento da fatura em aberto (`YYYY-MM-DD`).
   * `null` limpa o campo (pagamento recebido).
   */
  paymentDueDate?: string | null;
  /** Link da fatura no Asaas; `null` limpa quando o pagamento é confirmado. */
  invoiceUrl?: string | null;
  /** Momento (ISO) do último pagamento recebido. */
  lastPaymentAt?: string;
}

/**
 * Momento do pagamento informado pelo Asaas.
 *
 * O payload pode trazer só a data (`YYYY-MM-DD`) ou o timestamp completo;
 * quando nenhuma vem, usamos o instante do evento. Assim `PAYMENT_CONFIRMED` e
 * `PAYMENT_RECEIVED` da mesma cobrança convergem para o mesmo valor.
 */
function paymentTimestamp(
  payment: AsaasWebhookPayment | null,
  now: Date
): string {
  return (
    payment?.confirmedDate ??
    payment?.clientPaymentDate ??
    payment?.paymentDate ??
    now.toISOString()
  );
}

/**
 * Compara duas datas aceitando formatos diferentes (`ISO` x `YYYY-MM-DD`).
 * `dateOnly` ignora a hora — usado no vencimento da fatura (coluna `date`).
 */
function sameDate(
  next: string | null | undefined,
  current: string | null | undefined,
  dateOnly = false
): boolean {
  if (!next && !current) return true;
  if (!next || !current) return false;

  if (dateOnly) return toDateOnly(next) === toDateOnly(current);

  const nextMs = Date.parse(next);
  const currentMs = Date.parse(current);
  if (Number.isFinite(nextMs) && Number.isFinite(currentMs)) {
    return nextMs === currentMs;
  }

  return next === current;
}

/** Formato do `id` de `establishments` (uuid) — `externalReference` é livre. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Erro do PostgREST quando a migração de assinaturas ainda não rodou. */
const MISSING_COLUMN_PATTERN =
  /subscription_status|trial_ends_at|subscription_id|customer_payment_id/i;

/**
 * Erro do PostgREST quando a migração de cobrança (20261110000023) não rodou.
 * Nesse caso a loja é relida com `BASE_ESTABLISHMENT_COLUMNS` e os campos de
 * inadimplência são ignorados — o webhook continua funcionando.
 */
const OVERDUE_COLUMN_PATTERN =
  /payment_due_date|payment_invoice_url|last_payment_at/i;

/** Resposta padrão esperada pelo Asaas. */
function ack() {
  return NextResponse.json({ received: true });
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Compara o token recebido com o esperado em tempo constante.
 * O tamanho é checado antes porque `timingSafeEqual` exige buffers iguais.
 */
function isValidToken(received: string | null, expected: string): boolean {
  if (!received) return false;

  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (receivedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

/** Lê o JSON do corpo; payload inválido vira `null` (não derruba o endpoint). */
async function readPayload(
  request: Request
): Promise<AsaasWebhookPayload | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") return null;
    return body as AsaasWebhookPayload;
  } catch {
    return null;
  }
}

/** Monta as tentativas de busca da loja, sem repetir coluna+valor. */
function buildCandidates(payload: AsaasWebhookPayload): EstablishmentLookup[] {
  const payment = payload.payment ?? null;
  const subscription = payload.subscription ?? null;
  const candidates: EstablishmentLookup[] = [];

  const add = (column: LookupColumn, value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    if (
      candidates.some((item) => item.column === column && item.value === trimmed)
    ) {
      return;
    }
    candidates.push({ column, value: trimmed });
  };

  // O checkout cria a assinatura com `externalReference = establishments.id`.
  const externalReference =
    payment?.externalReference ?? subscription?.externalReference ?? null;
  if (externalReference && UUID_PATTERN.test(externalReference.trim())) {
    add("id", externalReference);
  }

  // Cobranças geradas pela assinatura trazem `subscription`.
  add("subscription_id", subscription?.id ?? payment?.subscription);

  // Fallback: loja localizada pelo cliente do Asaas (cobrança avulsa).
  add("customer_payment_id", payment?.customer ?? subscription?.customer);

  return candidates;
}

/**
 * Localiza a loja no Supabase.
 *
 * Cada candidato é consultado com as colunas completas e, quando o PostgREST
 * acusa que a migração de cobrança (20261110000023) não rodou, recua para as
 * colunas base — o webhook nunca deixa de sincronizar o status por causa de
 * uma migração pendente.
 *
 * Erro de coluna de assinatura ausente interrompe a busca (todas as tentativas
 * falhariam); qualquer outro erro apenas passa para a próxima tentativa.
 */
async function findEstablishment(
  admin: ReturnType<typeof createAdminClient>,
  candidates: EstablishmentLookup[]
): Promise<LookupResult> {
  let lastError: string | null = null;

  for (const { column, value } of candidates) {
    for (const columns of [ESTABLISHMENT_COLUMNS, BASE_ESTABLISHMENT_COLUMNS]) {
      const { data, error } = await admin
        .from("establishments")
        .select(columns)
        .eq(column, value)
        .limit(1)
        .maybeSingle();

      if (!error) {
        // Achou a loja (ou não existe com esse candidato) → próximo candidato.
        if (data) {
          return { status: "found", row: data as unknown as EstablishmentRow };
        }
        break;
      }

      if (MISSING_COLUMN_PATTERN.test(error.message ?? "")) {
        return { status: "schema-pending" };
      }

      // Migração de cobrança pendente: tenta de novo com as colunas base.
      if (
        columns === ESTABLISHMENT_COLUMNS &&
        OVERDUE_COLUMN_PATTERN.test(error.message ?? "")
      ) {
        continue;
      }

      lastError = error.message;
      console.error(
        `[webhook/asaas] falha ao consultar establishments por ${column}`,
        error
      );
      break;
    }
  }

  return lastError
    ? { status: "error", message: lastError }
    : { status: "missing" };
}

/**
 * Data de renovação a partir de uma cobrança paga: 30 dias após o vencimento
 * (ou após hoje, quando o pagamento chega atrasado).
 *
 * A base é normalizada para 00:00 UTC de propósito: `PAYMENT_CONFIRMED` e
 * `PAYMENT_RECEIVED` da mesma cobrança chegam com segundos de diferença e
 * precisam produzir exatamente a mesma data — do contrário cada notificação
 * esticaria o acesso.
 */
function nextPaidUntil(
  dueDate: string | null | undefined,
  now: Date
): string {
  const todayMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const parsedDue = dueDate
    ? Date.parse(`${dueDate.slice(0, 10)}T00:00:00.000Z`)
    : Number.NaN;
  const baseMs = Number.isFinite(parsedDue)
    ? Math.max(parsedDue, todayMs)
    : todayMs;

  return addTrialDays(new Date(baseMs), TRIAL_DAYS);
}

/**
 * Calcula o próximo estado da loja para o evento.
 *
 * Retorna `null` quando o evento não muda nada (já está no estado desejado,
 * período pago ainda vigente em uma cobrança vencida, loja já cancelada etc.).
 */
function resolveNextState(
  event: string,
  row: EstablishmentRow,
  payment: AsaasWebhookPayment | null,
  now: Date
): NextState | null {
  if (PAID_EVENTS.has(event)) {
    const paidUntil = nextPaidUntil(payment?.dueDate, now);
    const currentMs = row.trial_ends_at
      ? Date.parse(row.trial_ends_at)
      : Number.NaN;
    const alreadyCovered =
      Number.isFinite(currentMs) && currentMs >= Date.parse(paidUntil);

    // Pagamento confirmado libera o acesso na hora; a renovação só avança.
    // A cobrança em aberto é zerada, encerrando a carência de 15 dias.
    return {
      subscriptionStatus: "active",
      ...(alreadyCovered ? {} : { trialEndsAt: paidUntil }),
      paymentDueDate: null,
      invoiceUrl: null,
      lastPaymentAt: paymentTimestamp(payment, now),
    };
  }

  if (event === "PAYMENT_OVERDUE") {
    if (row.subscription_status === "canceled") return null;

    /**
     * O vencimento é registrado MESMO com o período pago ainda vigente: é dele
     * que sai a contagem dos 15 dias de carência quando o acesso expirar.
     * (`lib/storeEligibility.ts` nunca conta antes do fim do período pago.)
     */
    const overdueState: Pick<NextState, "paymentDueDate" | "invoiceUrl"> = {
      paymentDueDate: toDateOnly(payment?.dueDate) ?? todayDateOnly(now),
      invoiceUrl:
        payment?.invoiceUrl ?? row.payment_invoice_url ?? null,
    };

    // Enquanto o período pago (ou o trial) está vigente, a loja continua
    // ativa: o aviso de pagamento pendente só aparece quando o acesso venceu.
    const covered = row.trial_ends_at
      ? Date.parse(row.trial_ends_at) > now.getTime()
      : false;

    return {
      subscriptionStatus: covered
        ? row.subscription_status ?? "active"
        : "past_due",
      ...overdueState,
    };
  }

  /**
   * Cobrança removida no Asaas (`PAYMENT_DELETED`): a fatura deixa de existir,
   * então o vencimento registrado é limpo para não suspender a loja por uma
   * cobrança que não pode mais ser paga. O status NÃO muda — a carência segue
   * contando a partir do fim do período pago (`trial_ends_at`).
   */
  if (event === "PAYMENT_DELETED") {
    const deletedDue = toDateOnly(payment?.dueDate);
    if (!deletedDue) return null;
    if (deletedDue !== toDateOnly(row.payment_due_date)) return null;

    return {
      subscriptionStatus: row.subscription_status ?? "active",
      paymentDueDate: null,
      invoiceUrl: null,
    };
  }

  if (REFUND_EVENTS.has(event) || SUBSCRIPTION_END_EVENTS.has(event)) {
    return row.subscription_status === "canceled"
      ? null
      : { subscriptionStatus: "canceled" };
  }

  // Negativação: cobrança em cobrança administrativa — acesso retido até a
  // conciliação (uma cobrança recebida depois reativa a loja).
  if (event === "PAYMENT_DUNNING_RECEIVED") {
    const dueDate = toDateOnly(payment?.dueDate);

    return {
      subscriptionStatus: "past_due",
      ...(dueDate
        ? {
            paymentDueDate: dueDate,
            invoiceUrl: payment?.invoiceUrl ?? row.payment_invoice_url ?? null,
          }
        : {}),
    };
  }

  return null;
}

export async function POST(request: Request) {
  const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN?.trim();

  if (!expectedToken) {
    console.error(
      "[webhook/asaas] ASAAS_WEBHOOK_TOKEN não configurado — eventos recusados."
    );
    return fail("Webhook não configurado.", 500);
  }

  if (!isValidToken(request.headers.get("asaas-access-token"), expectedToken)) {
    console.warn("[webhook/asaas] token ausente ou inválido — evento recusado.");
    return fail("Token do webhook inválido.", 401);
  }

  const payload = await readPayload(request);
  if (!payload) {
    console.warn("[webhook/asaas] corpo inválido (JSON esperado) — ignorado.");
    return ack();
  }

  const event = (payload.event ?? "").trim();
  if (!event) {
    console.warn("[webhook/asaas] payload sem `event` — ignorado.");
    return ack();
  }

  // Eventos fora do escopo (PAYMENT_CREATED, PAYMENT_DELETED, transferências
  // etc.) são confirmados sem tocar no banco.
  if (!HANDLED_EVENTS.has(event)) {
    return ack();
  }

  const admin = createAdminClient();
  const lookup = await findEstablishment(admin, buildCandidates(payload));

  if (lookup.status === "schema-pending") {
    console.error(
      "[webhook/asaas] colunas de assinatura ausentes — aplique a migração 20261110000012."
    );
    return ack();
  }

  if (lookup.status === "error") {
    console.error(
      `[webhook/asaas] ${event}: falha ao localizar a loja`,
      lookup.message
    );
    return ack();
  }

  if (lookup.status === "missing") {
    console.warn(
      `[webhook/asaas] ${event}: nenhuma loja vinculada (evento ${payload.id ?? "sem id"}).`
    );
    return ack();
  }

  const next = resolveNextState(
    event,
    lookup.row,
    payload.payment ?? null,
    new Date()
  );

  if (!next) return ack();

  // Só grava o que realmente muda — reenvios do Asaas não geram UPDATE.
  const update: Record<string, string | null> = {};
  if (next.subscriptionStatus !== lookup.row.subscription_status) {
    update.subscription_status = next.subscriptionStatus;
  }
  if (next.trialEndsAt && !sameDate(next.trialEndsAt, lookup.row.trial_ends_at)) {
    update.trial_ends_at = next.trialEndsAt;
  }
  if (
    next.paymentDueDate !== undefined &&
    !sameDate(next.paymentDueDate, lookup.row.payment_due_date, true)
  ) {
    update.payment_due_date = next.paymentDueDate;
  }
  if (
    next.invoiceUrl !== undefined &&
    (lookup.row.payment_invoice_url ?? null) !== next.invoiceUrl
  ) {
    update.payment_invoice_url = next.invoiceUrl;
  }
  if (
    next.lastPaymentAt &&
    !sameDate(next.lastPaymentAt, lookup.row.last_payment_at)
  ) {
    update.last_payment_at = next.lastPaymentAt;
  }

  if (Object.keys(update).length === 0) return ack();

  const { error } = await admin
    .from("establishments")
    .update(update)
    .eq("id", lookup.row.id);

  if (error) {
    /**
     * Migração 20261110000023 pendente: grava só o essencial (status e
     * renovação) para não perder a sincronização da assinatura.
     */
    if (OVERDUE_COLUMN_PATTERN.test(error.message ?? "")) {
      const legacyUpdate: Record<string, string> = {};
      if (typeof update.subscription_status === "string") {
        legacyUpdate.subscription_status = update.subscription_status;
      }
      if (typeof update.trial_ends_at === "string") {
        legacyUpdate.trial_ends_at = update.trial_ends_at;
      }

      if (Object.keys(legacyUpdate).length > 0) {
        const retry = await admin
          .from("establishments")
          .update(legacyUpdate)
          .eq("id", lookup.row.id);

        if (!retry.error) {
          console.warn(
            "[webhook/asaas] migração 20261110000023 pendente — evento aplicado sem os campos de inadimplência."
          );
          return ack();
        }
      } else {
        return ack();
      }
    }

    // Respondemos 200 mesmo assim (o Asaas não deve reenfileirar por um erro
    // nosso); o polling de `/api/billing/status` reconcilia pagamentos pagos.
    console.error(
      `[webhook/asaas] ${event}: falha ao atualizar a loja ${lookup.row.id}`,
      error
    );
    return ack();
  }

  console.info(
    `[webhook/asaas] ${event}: loja ${lookup.row.id} → ${next.subscriptionStatus}` +
      (next.trialEndsAt ? ` (renovação em ${next.trialEndsAt})` : "") +
      (next.paymentDueDate === null
        ? " (fatura quitada)"
        : next.paymentDueDate
          ? ` (fatura vencendo em ${next.paymentDueDate})`
          : "")
  );

  // Pagamento aprovado de uma loja que havia sido desativada no cancelamento:
  // volta para o ar (lojas desligadas manualmente pelo Super Admin não são
  // afetadas — ver `restoreStoreAfterPayment`).
  if (next.subscriptionStatus === "active") {
    await restoreStoreAfterPayment(admin, lookup.row.id);
  }

  // O status da assinatura controla a vitrine pública (`/[slug]`): descarta o
  // cache da loja para a mudança valer imediatamente no link do cliente.
  const { data: slugRow } = await admin
    .from("establishments")
    .select("slug")
    .eq("id", lookup.row.id)
    .maybeSingle();

  revalidatePublicStore((slugRow as { slug?: string | null } | null)?.slug);

  return ack();
}
