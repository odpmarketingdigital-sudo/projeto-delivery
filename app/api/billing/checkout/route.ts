import { NextResponse } from "next/server";
import {
  AsaasError,
  createAsaasSubscription,
  findOrCreateAsaasCustomer,
  formatAsaasDate,
  getPixQrCode,
  listSubscriptionPayments,
  type AsaasPayment,
} from "@/lib/asaas";
import {
  isBillingType,
  isPaidPaymentStatus,
  validateBillingCustomer,
  validateCreditCard,
  type BillingCustomerInput,
  type BillingType,
  type CheckoutBoletoInfo,
  type CheckoutPixInfo,
  type CheckoutResponse,
  type CreditCardHolderInput,
  type CreditCardInput,
} from "@/lib/billing";
import {
  revalidatePublicStore,
  restoreStoreAfterPayment,
} from "@/lib/storeAvailability";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  addMonthsToDateOnly,
  computeBillingCyclePrice,
  isBillingCycleId,
  isSubscriptionActive,
  resolveRenewalDate,
  type BillingCyclePrice,
  type SubscriptionStatus,
} from "@/lib/subscriptions";
import {
  buildSubscriptionCouponQuote,
  isValidSubscriptionCouponCode,
  normalizeSubscriptionCouponCode,
  subscriptionCouponEligibilityError,
  type SubscriptionCouponQuote,
  type SubscriptionCouponRecord,
} from "@/lib/subscription-coupons";
import {
  consumeSubscriptionCouponUsage,
  findSubscriptionCouponByCode,
} from "@/lib/subscription-coupons-server";
import { getSubscriptionPlan } from "@/lib/settings";

/**
 * POST /api/billing/checkout — contrata o Plano Profissional no Asaas.
 *
 * Fluxo (tudo no servidor):
 *  1. Exige sessão de admin e resolve a loja (admin = a própria; super admin
 *     informa `establishment_id`).
 *  2. Valida os dados de faturamento (CPF/CNPJ com dígito verificador) e, no
 *     cartão, os dados do titular.
 *  3. Calcula o ciclo escolhido (mensal / semestral −5% / anual −10%) e aplica
 *     o cupom de assinatura, quando informado.
 *  4. Cupom que zera o período (ex.: 100% de desconto): ativa a assinatura
 *     direto no banco como `active`, sem chamar o gateway — a rota devolve
 *     `isFree: true` e o modal encerra o fluxo na hora.
 *  5. Reaproveita/cria o cliente no Asaas (`customer_payment_id`).
 *  6. Cria a assinatura recorrente com a forma e o ciclo escolhidos.
 *  7. Persiste `subscription_id`/`plan_id` e libera o acesso quando a primeira
 *     cobrança já nasce paga (cartão aprovado).
 *  8. Devolve o QR Code Pix, o link do boleto ou o status do cartão.
 *
 * Nenhum dado de cartão é gravado: ele só transita até o Asaas.
 */

/** Colunas necessárias da loja (as de assinatura vêm da migração 20261110000012). */
const ESTABLISHMENT_COLUMNS =
  "id, name, slug, email, subscription_status, trial_ends_at, subscription_id, customer_payment_id, plan_id";

/** Loja mínima usada pela rota. */
interface BillingEstablishmentRow {
  id: string;
  name: string | null;
  /** Slug público — usado para invalidar o cache de `/[slug]`. */
  slug: string | null;
  email: string | null;
  subscription_status: SubscriptionStatus | null;
  trial_ends_at: string | null;
  subscription_id: string | null;
  customer_payment_id: string | null;
  plan_id: string | null;
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Converte um erro do Asaas na resposta HTTP da rota.
 * Cartão recusado vira 402 (Payment Required); demais falhas do gateway, 400.
 */
function asaasFailure(
  error: unknown,
  fallback: string,
  billingType?: BillingType
) {
  if (error instanceof AsaasError) {
    const isClientError = error.status >= 400 && error.status < 500;
    const status = isClientError
      ? billingType === "CREDIT_CARD"
        ? 402
        : 400
      : 502;

    return fail(error.message, status);
  }

  console.error("[billing/checkout]", error);
  return fail(fallback, 500);
}

/** Objeto JSON (ou `null` quando o valor não é um objeto simples). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** String aparada de um objeto vindo do cliente (vazio quando ausente). */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Extrai os dados de faturamento do body. */
function parseCustomer(value: unknown): BillingCustomerInput | null {
  const record = asRecord(value);
  if (!record) return null;

  return {
    name: readString(record, "name"),
    email: readString(record, "email"),
    cpfCnpj: readString(record, "cpfCnpj"),
    phone: readString(record, "phone"),
  };
}

/** Extrai os dados do cartão do body. */
function parseCreditCard(value: unknown): CreditCardInput | null {
  const record = asRecord(value);
  if (!record) return null;

  return {
    holderName: readString(record, "holderName"),
    number: readString(record, "number"),
    expiryMonth: readString(record, "expiryMonth"),
    expiryYear: readString(record, "expiryYear"),
    ccv: readString(record, "ccv"),
  };
}

/** Extrai o endereço do titular do cartão do body. */
function parseCreditCardHolder(value: unknown): CreditCardHolderInput | null {
  const record = asRecord(value);
  if (!record) return null;

  return {
    postalCode: readString(record, "postalCode"),
    addressNumber: readString(record, "addressNumber"),
  };
}

/** IP do comprador (antifraude do cartão). */
function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;

  return request.headers.get("x-real-ip")?.trim() || "127.0.0.1";
}

/** Ordena as cobranças da mais antiga para a mais recente (ISO `YYYY-MM-DD`). */
function sortPayments(payments: AsaasPayment[]): AsaasPayment[] {
  return [...payments].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * Cobrança que o cliente deve pagar agora: a primeira em aberto ou, quando
 * todas já estão pagas, a mais recente.
 */
function pickCheckoutPayment(payments: AsaasPayment[]): AsaasPayment | null {
  if (payments.length === 0) return null;

  const sorted = sortPayments(payments);
  const open = sorted.find(
    (payment) =>
      !isPaidPaymentStatus(payment.status) &&
      payment.status !== "REFUNDED" &&
      payment.status !== "CHARGEBACK_REQUESTED"
  );

  return open ?? sorted[sorted.length - 1];
}

/**
 * Cobrança já existente da assinatura da loja.
 *
 * Evita abrir uma segunda recorrência quando o cliente fecha o modal antes de
 * pagar (Pix/boleto em aberto ou cartão em análise) e volta para a tela de
 * assinatura: a mesma cobrança é devolvida. `null` significa que é preciso
 * contratar de novo.
 */
async function findReusablePayment(
  subscriptionId: string
): Promise<AsaasPayment | null> {
  let payments: AsaasPayment[];

  try {
    payments = await listSubscriptionPayments(subscriptionId);
  } catch (error) {
    // Assinatura removida/cancelada no painel do Asaas: segue o fluxo normal.
    console.error(
      "[billing/checkout] falha ao consultar a assinatura existente",
      error
    );
    return null;
  }

  // Cobranças estornadas/contestadas não servem: é preciso gerar outra.
  const usable = payments.filter(
    (payment) =>
      payment.status !== "REFUNDED" &&
      payment.status !== "CHARGEBACK_REQUESTED" &&
      payment.status !== "CHARGEBACK_DISPUTE" &&
      payment.status !== "DELETED"
  );

  if (usable.length === 0) return null;

  return sortPayments(usable)[usable.length - 1];
}

/** Monta o QR Code Pix da cobrança (undefined quando não se aplica/falhou). */
async function buildPixInfo(
  payment: AsaasPayment | null
): Promise<CheckoutPixInfo | undefined> {
  if (
    !payment ||
    payment.billingType !== "PIX" ||
    isPaidPaymentStatus(payment.status)
  ) {
    return undefined;
  }

  try {
    const qrCode = await getPixQrCode(payment.id);
    if (!qrCode.encodedImage || !qrCode.payload) return undefined;

    return {
      paymentId: payment.id,
      encodedImage: qrCode.encodedImage,
      payload: qrCode.payload,
      expirationDate: qrCode.expirationDate,
      invoiceUrl: payment.invoiceUrl ?? null,
    };
  } catch (error) {
    // Sem QR Code a cobrança continua válida pelo link da fatura.
    console.error("[billing/checkout] falha ao gerar o QR Code Pix", error);
    return undefined;
  }
}

/** Monta os dados do boleto (undefined quando a cobrança não é boleto). */
function buildBoletoInfo(
  payment: AsaasPayment | null
): CheckoutBoletoInfo | undefined {
  if (!payment || payment.billingType !== "BOLETO") return undefined;

  return {
    paymentId: payment.id,
    invoiceUrl: payment.invoiceUrl ?? null,
    bankSlipUrl: payment.bankSlipUrl ?? null,
    dueDate: payment.dueDate,
    value: payment.value,
  };
}

/** Dados de uma contratação com o período zerado pelo cupom. */
interface FreeActivationInput {
  adminClient: ReturnType<typeof createAdminClient>;
  establishment: BillingEstablishmentRow;
  /** Plano vigente (`system_settings`), gravado em `plan_id`. */
  planId: string;
  billingCycle: BillingCyclePrice;
  quote: SubscriptionCouponQuote;
  coupon: SubscriptionCouponRecord | null;
}

/**
 * Ativa a assinatura SEM cobrança (cupom que zera o total do período).
 *
 * Nada é enviado ao gateway de pagamento: a loja é gravada como `active` com o
 * plano, o ciclo e a próxima renovação, e o uso do cupom é contabilizado — o
 * mesmo estado final do fluxo pago depois da confirmação do Asaas. Como não há
 * assinatura recorrente, `subscription_id` fica nulo (uma contratação futura
 * cria uma nova, em vez de reaproveitar uma cobrança antiga).
 */
async function activateFreeSubscription({
  adminClient,
  establishment,
  planId,
  billingCycle,
  quote,
  coupon,
}: FreeActivationInput): Promise<NextResponse> {
  const today = formatAsaasDate();

  // Renovação: estende o período vigente quando ainda válido; do contrário,
  // começa a contar de hoje. A leitura é isolada porque a coluna pertence à
  // migração 20261110000019 (base antiga simplesmente cai em `today`).
  const { data: expiryRow } = await adminClient
    .from("establishments")
    .select("subscription_expires_at")
    .eq("id", establishment.id)
    .maybeSingle();

  const storedExpiry =
    typeof expiryRow?.subscription_expires_at === "string"
      ? expiryRow.subscription_expires_at.slice(0, 10)
      : null;
  const baseDate = storedExpiry && storedExpiry > today ? storedExpiry : today;
  const renewalDate = addMonthsToDateOnly(baseDate, billingCycle.months);

  const freeFields = {
    plan_id: planId,
    subscription_status: "active" as SubscriptionStatus,
    // Sem recorrência no gateway: solta o vínculo antigo (cancelado ou com
    // cobrança em aberto) para não reabrir uma assinatura já encerrada.
    subscription_id: null,
  };

  const fullUpdate = await adminClient
    .from("establishments")
    .update({
      ...freeFields,
      subscription_cycle: billingCycle.id,
      subscription_expires_at: renewalDate,
    })
    .eq("id", establishment.id);

  let updateError = fullUpdate.error;

  // Migração 20261110000019 pendente: salva o essencial e segue.
  if (
    updateError &&
    /subscription_cycle|subscription_expires_at/i.test(updateError.message ?? "")
  ) {
    console.warn(
      "[billing/checkout] migração 20261110000019 pendente — ciclo/vencimento não salvos (ativação grátis)"
    );

    const fallback = await adminClient
      .from("establishments")
      .update(freeFields)
      .eq("id", establishment.id);

    updateError = fallback.error;
  }

  if (updateError) {
    console.error(
      "[billing/checkout] falha ao registrar a ativação grátis",
      updateError
    );
    return fail(
      "Não foi possível ativar a assinatura gratuita agora. Tente novamente em instantes.",
      500
    );
  }

  // Assinatura ativa: reabre a loja que estava suspensa e descarta o cache de
  // `/[slug]` para o cardápio público refletir na hora.
  await restoreStoreAfterPayment(adminClient, establishment.id);
  revalidatePublicStore(establishment.slug);

  // Mesma regra do fluxo pago: o uso só é contabilizado depois de a assinatura
  // estar válida; falha aqui não desfaz a ativação.
  if (coupon) {
    const consumed = await consumeSubscriptionCouponUsage(coupon.id);
    if (!consumed) {
      console.warn(
        `[billing/checkout] cupom ${coupon.code} aplicado sem contabilizar o uso (ativação grátis)`
      );
    }
  }

  const response: CheckoutResponse = {
    // Não existe assinatura nem cliente no gateway neste fluxo.
    subscriptionId: null,
    customerId: null,
    // Forma de pagamento simbólica: nada foi cobrado (o modal envia Pix).
    billingType: "PIX",
    paymentStatus: null,
    subscriptionStatus: "active",
    isFree: true,
    billingCycle: billingCycle.id,
    cycleLabel: billingCycle.label,
    durationLabel: billingCycle.durationLabel,
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    totalCents: quote.totalCents,
    couponCode: quote.couponCode,
  };

  return NextResponse.json(response, { status: 201 });
}

export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> | null = null;
  try {
    body = asRecord(await request.json());
  } catch {
    body = null;
  }

  if (!body) return fail("Corpo da requisição inválido.");

  const billingType = body.billingType;
  if (!isBillingType(billingType)) {
    return fail("Escolha a forma de pagamento: Pix, cartão de crédito ou boleto.");
  }

  const customer = parseCustomer(body.customer);
  if (!customer) return fail("Informe os dados de faturamento.");

  const customerError = validateBillingCustomer(customer);
  if (customerError) return fail(customerError);

  let creditCard: CreditCardInput | undefined;
  let creditCardHolder: CreditCardHolderInput | undefined;

  if (billingType === "CREDIT_CARD") {
    creditCard = parseCreditCard(body.creditCard) ?? undefined;
    creditCardHolder = parseCreditCardHolder(body.creditCardHolderInfo) ?? undefined;

    if (!creditCard || !creditCardHolder) {
      return fail("Informe os dados do cartão de crédito e do titular.");
    }

    const cardError = validateCreditCard(creditCard, creditCardHolder);
    if (cardError) return fail(cardError);
  }

  const requestedId =
    typeof body.establishment_id === "string"
      ? body.establishment_id.trim()
      : "";

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    requestedId
  );
  if ("response" in resolved) return resolved.response;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return fail("Você não pode gerenciar a assinatura desta loja.", 403);
  }

  const adminClient = createAdminClient();

  const { data: establishmentData, error: establishmentError } = await adminClient
    .from("establishments")
    .select(ESTABLISHMENT_COLUMNS)
    .eq("id", resolved.id)
    .maybeSingle();

  if (establishmentError) {
    const missingColumns = /subscription_status|trial_ends_at|plan_id|subscription_id|customer_payment_id/i.test(
      establishmentError.message ?? ""
    );

    if (missingColumns) {
      return fail(
        "As colunas de assinatura ainda não existem no banco. Execute a " +
          "migração 20261110000012_add_subscriptions_to_establishments.sql " +
          "no SQL Editor do Supabase.",
        500
      );
    }

    return fail("Não foi possível carregar o estabelecimento.", 500);
  }

  const establishment = establishmentData as BillingEstablishmentRow | null;
  if (!establishment) return fail("Estabelecimento não encontrado.", 404);

  // Preço vigente do plano (system_settings), com fallback de R$ 97,00 quando a
  // configuração ainda não existe. Vale para as próximas assinaturas criadas.
  const plan = await getSubscriptionPlan();

  if (establishment.subscription_status === "active" && establishment.subscription_id) {
    return fail("Esta loja já possui uma assinatura ativa.", 409);
  }

  // ---- Ciclo de cobrança + cupom de assinatura -----------------------------
  //
  // O ciclo define o total do período (mensal, semestral −5% ou anual −10%) e o
  // cupom incide sobre esse total. Todo o cálculo é refeito aqui: o valor que
  // chega do navegador nunca é usado para cobrar.
  //
  // Vem antes do reaproveitamento de cobranças para que um cupom de 100% não
  // caia numa fatura antiga em aberto (o fluxo é gratuito, não há o que pagar).
  if (body.cycle !== undefined && !isBillingCycleId(body.cycle)) {
    return fail(
      "Ciclo de cobrança inválido. Escolha mensal, semestral ou anual."
    );
  }

  const billingCycle = computeBillingCyclePrice(
    plan.priceCents,
    isBillingCycleId(body.cycle) ? body.cycle : "monthly"
  );

  const requestedCouponCode = normalizeSubscriptionCouponCode(
    typeof body.couponCode === "string" ? body.couponCode : ""
  );

  let coupon: SubscriptionCouponRecord | null = null;

  if (requestedCouponCode) {
    if (!isValidSubscriptionCouponCode(requestedCouponCode)) {
      return fail("Código de cupom inválido.");
    }

    try {
      coupon = await findSubscriptionCouponByCode(requestedCouponCode);
    } catch (error) {
      console.error("[billing/checkout] falha ao consultar o cupom", error);
      return fail(
        "Não foi possível validar o cupom agora. Remova o cupom ou tente novamente.",
        500
      );
    }

    if (!coupon) {
      return fail("Cupom de desconto não encontrado.");
    }

    const couponError = subscriptionCouponEligibilityError(
      coupon,
      billingCycle.totalCents
    );
    if (couponError) return fail(couponError);
  }

  const quote = buildSubscriptionCouponQuote(billingCycle, coupon);

  // ---- Ativação gratuita (total R$ 0,00) -----------------------------------
  //
  // Cupom que zera o período: não existe valor a cobrar, então o gateway não é
  // chamado. A assinatura é registrada no banco já como `active`, com plano,
  // ciclo e próxima renovação.
  if (quote.totalCents <= 0) {
    return activateFreeSubscription({
      adminClient,
      establishment,
      planId: plan.id,
      billingCycle,
      quote,
      coupon,
    });
  }

  // Assinatura já contratada com cobrança pendente (Pix/boleto em aberto ou
  // cartão em análise): devolve a mesma cobrança em vez de criar uma segunda
  // recorrência — o cliente pode ter fechado o modal antes de pagar.
  //
  // Loja com assinatura cancelada fica de fora: reativar exige uma assinatura
  // nova (a antiga não volta a cobrar e o pagamento anterior já foi usado).
  if (
    establishment.subscription_id &&
    establishment.subscription_status !== "canceled"
  ) {
    const reusable = await findReusablePayment(establishment.subscription_id);

    if (reusable) {
      const paidNow = isPaidPaymentStatus(reusable.status);

      // Pagamento confirmado com o banco desatualizado: libera o acesso aqui
      // também, sem esperar o próximo ciclo do polling.
      if (paidNow) {
        const { error: reuseUpdateError } = await adminClient
          .from("establishments")
          .update({ subscription_status: "active", plan_id: plan.id })
          .eq("id", establishment.id);

        if (reuseUpdateError) {
          console.error(
            "[billing/checkout] falha ao liberar a assinatura já paga",
            reuseUpdateError
          );
        } else {
          // Pagamento aprovado: se a loja estava fora do ar por causa do
          // cancelamento, volta a receber pedidos agora.
          await restoreStoreAfterPayment(adminClient, establishment.id);
          revalidatePublicStore(establishment.slug);
        }
      }

      const reused: CheckoutResponse = {
        subscriptionId: establishment.subscription_id,
        customerId: establishment.customer_payment_id ?? reusable.customer,
        // A forma de pagamento devolvida é a da cobrança reaproveitada (pode
        // diferir da escolhida agora).
        billingType: reusable.billingType,
        paymentStatus: reusable.status,
        subscriptionStatus: paidNow
          ? "active"
          : establishment.subscription_status ?? "trialing",
        pix: await buildPixInfo(reusable),
        boleto: buildBoletoInfo(reusable),
      };

      return NextResponse.json(reused, { status: paidNow ? 200 : 201 });
    }
  }

  // Cliente no Asaas: reaproveita por e-mail/CPF-CNPJ quando já existe.
  let customerId: string;
  try {
    const asaasCustomer = await findOrCreateAsaasCustomer({
      name: customer.name,
      email: customer.email,
      cpfCnpj: customer.cpfCnpj,
      phone: customer.phone,
      externalReference: establishment.id,
    });
    customerId = asaasCustomer.id;
  } catch (error) {
    return asaasFailure(
      error,
      "Não foi possível cadastrar os dados de faturamento no Asaas.",
      billingType
    );
  }

  // Assinatura no ciclo escolhido (a primeira cobrança vence hoje).
  let subscription: Awaited<ReturnType<typeof createAsaasSubscription>>;
  try {
    subscription = await createAsaasSubscription({
      customerId,
      billingType,
      value: quote.totalCents / 100,
      nextDueDate: formatAsaasDate(),
      cycle: billingCycle.asaasCycle,
      description:
        `Assinatura ${plan.name} — ${billingCycle.label} ` +
        `(${billingCycle.durationLabel})` +
        (coupon ? ` · cupom ${coupon.code}` : ""),
      externalReference: establishment.id,
      ...(billingType === "CREDIT_CARD" && creditCard && creditCardHolder
        ? {
            creditCard,
            creditCardHolderInfo: {
              name: customer.name,
              email: customer.email,
              cpfCnpj: customer.cpfCnpj,
              postalCode: creditCardHolder.postalCode,
              addressNumber: creditCardHolder.addressNumber,
              phone: customer.phone,
            },
            remoteIp: getClientIp(request),
          }
        : {}),
    });
  } catch (error) {
    return asaasFailure(
      error,
      "Não foi possível criar a assinatura. Tente novamente em instantes.",
      billingType
    );
  }

  // A cobrança pode não estar disponível no exato instante da criação; nesse
  // caso a rota devolve a assinatura sem QR Code e o modal segue no polling.
  let payment: AsaasPayment | null = null;
  try {
    payment = pickCheckoutPayment(
      await listSubscriptionPayments(subscription.id)
    );
  } catch (error) {
    console.error("[billing/checkout] falha ao listar as cobranças", error);
  }

  const paid = isPaidPaymentStatus(payment?.status);
  const currentStatus: SubscriptionStatus =
    establishment.subscription_status ?? "trialing";

  // Pago agora → libera na hora. Ainda em aberto → mantém o trial enquanto
  // válido e marca `past_due` quando o período de teste já terminou.
  const nextStatus: SubscriptionStatus = paid
    ? "active"
    : isSubscriptionActive({
        subscription_status: currentStatus,
        trial_ends_at: establishment.trial_ends_at,
      })
      ? currentStatus
      : "past_due";

  // Ciclo e renovação exibidos no card "Situação da conta". A data parte do
  // vencimento devolvido pelo Asaas (hoje, na criação) e avança o período pago
  // (1, 6 ou 12 meses) para a próxima cobrança.
  const renewalDate = resolveRenewalDate(
    subscription.nextDueDate ?? formatAsaasDate(),
    billingCycle.months
  );

  const subscriptionFields = {
    customer_payment_id: customerId,
    subscription_id: subscription.id,
    plan_id: plan.id,
    subscription_status: nextStatus,
  };

  const fullUpdate = await adminClient
    .from("establishments")
    .update({
      ...subscriptionFields,
      subscription_cycle: billingCycle.id,
      ...(renewalDate ? { subscription_expires_at: renewalDate } : {}),
    })
    .eq("id", establishment.id);

  let updateError = fullUpdate.error;

  // Migração 20261110000019 pendente: salva o essencial e deixa ciclo/vencimento
  // para o `GET /api/billing/status` (que lê esses dados do gateway).
  if (
    updateError &&
    /subscription_cycle|subscription_expires_at/i.test(updateError.message ?? "")
  ) {
    console.warn(
      "[billing/checkout] migração 20261110000019 pendente — ciclo/vencimento não salvos"
    );

    const fallback = await adminClient
      .from("establishments")
      .update(subscriptionFields)
      .eq("id", establishment.id);

    updateError = fallback.error;
  }

  if (updateError) {
    console.error("[billing/checkout] falha ao salvar a assinatura", updateError);

    // A cobrança já existe no Asaas: informar o código ajuda o suporte a
    // reconciliar sem gerar uma segunda assinatura para a loja.
    return fail(
      "A assinatura foi criada no Asaas, mas não conseguimos vinculá-la à sua " +
        `loja. Fale com o suporte informando o código ${subscription.id}.`,
      500
    );
  }

  // Assinatura vinculada: `paid` reabre a loja que havia sido desativada pelo
  // cancelamento e o cache de `/[slug]` é descartado para refletir na hora.
  if (paid) {
    await restoreStoreAfterPayment(adminClient, establishment.id);
  }
  revalidatePublicStore(establishment.slug);

  // Contabiliza o uso do cupom só depois de a assinatura estar vinculada à
  // loja. Falha aqui não desfaz a contratação (o uso fica faltando no painel).
  if (coupon) {
    const consumed = await consumeSubscriptionCouponUsage(coupon.id);
    if (!consumed) {
      console.warn(
        `[billing/checkout] cupom ${coupon.code} aplicado sem contabilizar o uso`
      );
    }
  }

  const response: CheckoutResponse = {
    subscriptionId: subscription.id,
    customerId,
    billingType,
    paymentStatus: payment?.status ?? null,
    subscriptionStatus: nextStatus,
    billingCycle: billingCycle.id,
    cycleLabel: billingCycle.label,
    durationLabel: billingCycle.durationLabel,
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    totalCents: quote.totalCents,
    couponCode: quote.couponCode,
    pix: await buildPixInfo(payment),
    boleto: buildBoletoInfo(payment),
  };

  return NextResponse.json(response, { status: paid ? 200 : 201 });
}


