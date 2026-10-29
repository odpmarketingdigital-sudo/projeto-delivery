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
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  computeBillingCyclePrice,
  isBillingCycleId,
  isSubscriptionActive,
  type SubscriptionStatus,
} from "@/lib/subscriptions";
import {
  buildSubscriptionCouponQuote,
  isValidSubscriptionCouponCode,
  normalizeSubscriptionCouponCode,
  subscriptionCouponEligibilityError,
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
 *  4. Reaproveita/cria o cliente no Asaas (`customer_payment_id`).
 *  5. Cria a assinatura recorrente com a forma e o ciclo escolhidos.
 *  6. Persiste `subscription_id`/`plan_id` e libera o acesso quando a primeira
 *     cobrança já nasce paga (cartão aprovado).
 *  7. Devolve o QR Code Pix, o link do boleto ou o status do cartão.
 *
 * Nenhum dado de cartão é gravado: ele só transita até o Asaas.
 */

/** Colunas necessárias da loja (as de assinatura vêm da migração 20261110000012). */
const ESTABLISHMENT_COLUMNS =
  "id, name, email, subscription_status, trial_ends_at, subscription_id, customer_payment_id, plan_id";

/** Loja mínima usada pela rota. */
interface BillingEstablishmentRow {
  id: string;
  name: string | null;
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

  // ---- Ciclo de cobrança + cupom de assinatura -----------------------------
  //
  // O ciclo define o total do período (mensal, semestral −5% ou anual −10%) e o
  // cupom incide sobre esse total. Todo o cálculo é refeito aqui: o valor que
  // chega do navegador nunca é usado para cobrar.
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

  if (quote.totalCents <= 0) {
    return fail(
      "O desconto deste cupom zera o valor da assinatura. Remova o cupom para continuar."
    );
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

  const { error: updateError } = await adminClient
    .from("establishments")
    .update({
      customer_payment_id: customerId,
      subscription_id: subscription.id,
      plan_id: plan.id,
      subscription_status: nextStatus,
    })
    .eq("id", establishment.id);

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


