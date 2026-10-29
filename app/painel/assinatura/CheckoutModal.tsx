"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  BILLING_TYPES,
  BILLING_TYPE_LABELS,
  formatCardNumberInput,
  formatCpfCnpjInput,
  formatPhoneInput,
  formatPostalCodeInput,
  isPaidPaymentStatus,
  onlyDigits,
  validateBillingCustomer,
  validateCreditCard,
  type BillingCustomerInput,
  type BillingStatusResponse,
  type BillingType,
  type CheckoutResponse,
  type CreditCardInput,
} from "@/lib/billing";
import {
  normalizeSubscriptionCouponCode,
  type SubscriptionCouponQuote,
} from "@/lib/subscription-coupons";
import { formatBRL, type BillingCyclePrice } from "@/lib/subscriptions";

/**
 * Modal de contratação do Plano Profissional (2 passos).
 *
 *  1. Dados de faturamento (nome, e-mail, CPF/CNPJ e telefone);
 *  2. Pagamento — forma (Pix, cartão ou boleto), cupom de desconto e resumo do
 *     período contratado (mensal, semestral −5% ou anual −10%). Ao concluir,
 *     chama `POST /api/billing/checkout` e passa a consultar
 *     `GET /api/billing/status` até o Asaas confirmar o pagamento.
 *
 * Dados de cartão vivem apenas no estado do componente: não são persistidos em
 * lugar nenhum (nem em `localStorage`).
 */

interface CheckoutModalProps {
  /** Loja alvo; o servidor valida a permissão e ignora quando é admin. */
  establishmentId: string | null;
  /** Período escolhido na tela de assinatura, já com os valores calculados. */
  cyclePrice: BillingCyclePrice;
  planName: string;
  onClose: () => void;
  /** Chamado quando o pagamento é confirmado (relê a assinatura no painel). */
  onConfirmed: () => void;
}

type Step = "billing" | "payment";

/** Classes compartilhadas dos campos (mesmo padrão dos demais modais). */
const INPUT_CLASS =
  "w-full rounded-xl border border-gray-700 bg-gray-950/60 px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 focus:border-yellow-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400/40";
const LABEL_CLASS = "mb-1.5 block text-sm font-semibold text-gray-200";

/** Rótulos curtos exibidos nos botões de pagamento. */
const PAYMENT_HINTS: Record<BillingType, string> = {
  PIX: "Liberação imediata",
  CREDIT_CARD: "Cobrança recorrente no cartão",
  BOLETO: "Compensação em até 2 dias úteis",
};

/** Máscara de validade do cartão (MM/AA). */
function formatExpiryInput(value: string): string {
  const digits = onlyDigits(value).slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

/** Separa a validade digitada em mês e ano com 4 dígitos. */
function splitExpiry(value: string): { month: string; year: string } {
  const [rawMonth = "", rawYear = ""] = value.split("/");
  const month = onlyDigits(rawMonth).padStart(2, "0");
  const yearDigits = onlyDigits(rawYear);

  const year =
    yearDigits.length === 4
      ? yearDigits
      : yearDigits.length > 0
        ? `20${yearDigits}`
        : "";

  return { month, year };
}

/** Formata datas do Asaas (`YYYY-MM-DD HH:mm:ss`) para pt-BR. */
function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** Formata `YYYY-MM-DD` para `dd/mm/aaaa`. */
function formatDateOnly(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("pt-BR");
}

export function CheckoutModal({
  establishmentId,
  cyclePrice,
  planName,
  onClose,
  onConfirmed,
}: CheckoutModalProps) {
  const [step, setStep] = useState<Step>("billing");
  const [customer, setCustomer] = useState<BillingCustomerInput>({
    name: "",
    email: "",
    cpfCnpj: "",
    phone: "",
  });
  const [billingType, setBillingType] = useState<BillingType>("PIX");
  const [card, setCard] = useState({
    holderName: "",
    number: "",
    expiry: "",
    ccv: "",
  });
  const [holder, setHolder] = useState({ postalCode: "", addressNumber: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<CheckoutResponse | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [pixCopied, setPixCopied] = useState(false);
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<SubscriptionCouponQuote | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [isCouponChecking, setIsCouponChecking] = useState(false);

  // O callback pode mudar de identidade a cada render da página; o polling usa
  // a versão mais recente sem reiniciar o intervalo.
  const onConfirmedRef = useRef(onConfirmed);
  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  }, [onConfirmed]);

  // Fecha com ESC e trava o scroll do body enquanto o modal está aberto.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) onClose();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, isSubmitting]);

  const isCard = billingType === "CREDIT_CARD";
  const pixExpiration = formatDateTime(result?.pix?.expirationDate ?? null);
  const boletoDueDate = formatDateOnly(result?.boleto?.dueDate ?? null);
  const boletoUrl =
    result?.boleto?.bankSlipUrl ??
    result?.boleto?.invoiceUrl ??
    result?.pix?.invoiceUrl ??
    null;
  const lastCheckLabel = formatDateTime(lastCheckedAt);

  // Resumo do período: o total do ciclo já embute o desconto de 5% (semestral)
  // ou 10% (anual); o cupom incide sobre esse total.
  const subtotalCents = cyclePrice.totalCents;
  const couponDiscountCents = coupon?.discountCents ?? 0;
  const totalCents = Math.max(0, subtotalCents - couponDiscountCents);
  const totalLabel = formatBRL(totalCents);
  const hasCycleDiscount = cyclePrice.discountCents > 0;

  /** Atualiza um campo de faturamento. */
  const updateCustomer = (field: keyof BillingCustomerInput, value: string) => {
    setCustomer((previous) => ({ ...previous, [field]: value }));
  };

  /**
   * Valida o cupom digitado em `POST /api/billing/coupon` e guarda a prévia do
   * desconto. O checkout recalcula tudo no servidor antes de cobrar.
   */
  const handleApplyCoupon = async () => {
    const code = normalizeSubscriptionCouponCode(couponInput);
    if (!code) {
      setCouponError("Informe o código do cupom.");
      return;
    }

    setIsCouponChecking(true);
    setCouponError(null);

    try {
      const response = await fetch("/api/billing/coupon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, cycle: cyclePrice.id }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Não foi possível validar o cupom."
        );
      }

      const quote = data as unknown as SubscriptionCouponQuote;
      setCoupon(quote);
      setCouponInput(quote.couponCode ?? code);
    } catch (couponFailure) {
      setCoupon(null);
      setCouponError(
        couponFailure instanceof Error
          ? couponFailure.message
          : "Não foi possível validar o cupom."
      );
    } finally {
      setIsCouponChecking(false);
    }
  };

  /** Remove o cupom aplicado (volta ao total do período). */
  const handleRemoveCoupon = () => {
    setCoupon(null);
    setCouponInput("");
    setCouponError(null);
  };

  /** Passo 1 → 2 (dados de faturamento validados no cliente). */
  const handleBillingNext = (event: FormEvent) => {
    event.preventDefault();
    const message = validateBillingCustomer(customer);
    if (message) {
      setError(message);
      return;
    }

    setError(null);
    setNotice(null);
    setStep("payment");
  };

  /**
   * Consulta `GET /api/billing/status`. Devolve `true` quando a assinatura já
   * está ativa (o pagamento foi confirmado pelo Asaas).
   */
  const checkPayment = useCallback(async (): Promise<boolean> => {
    if (!establishmentId) return false;

    try {
      const response = await fetch(
        `/api/billing/status?establishment_id=${encodeURIComponent(establishmentId)}`,
        { cache: "no-store" }
      );

      if (!response.ok) return false;

      const data = (await response.json()) as BillingStatusResponse;
      setLastCheckedAt(data.checkedAt);

      if (data.subscriptionStatus === "active" && data.isActive) {
        setIsPaid(true);
        onConfirmedRef.current();
        return true;
      }
    } catch {
      // Rede instável: o próximo ciclo do polling tenta novamente.
    }

    return false;
  }, [establishmentId]);

  // Polling de 5s enquanto a cobrança está em aberto (Pix, boleto ou cartão em
  // análise). Para ao confirmar ou quando o modal é fechado.
  //
  // A primeira verificação é agendada (em vez de chamada direta no corpo do
  // efeito) para não disparar `setState` síncrono durante o efeito.
  useEffect(() => {
    if (!result || isPaid) return;

    let cancelled = false;

    const runCheck = () => {
      if (cancelled) return;
      void checkPayment();
    };

    const initialCheck = window.setTimeout(runCheck, 0);
    const timer = window.setInterval(runCheck, 5000);

    return () => {
      cancelled = true;
      window.clearTimeout(initialCheck);
      window.clearInterval(timer);
    };
  }, [result, isPaid, checkPayment]);

  /** Botão "Já paguei" — força uma verificação imediata. */
  const handleManualCheck = async () => {
    setIsChecking(true);
    setError(null);
    setNotice(null);

    try {
      const paid = await checkPayment();
      if (!paid) {
        setNotice(
          "Ainda não identificamos o pagamento. Se você acabou de pagar, aguarde alguns segundos e verifique de novo."
        );
      }
    } finally {
      setIsChecking(false);
    }
  };

  /** Envia o checkout e exibe o QR Code Pix, o boleto ou o resultado do cartão. */
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const customerError = validateBillingCustomer(customer);
    if (customerError) {
      setStep("billing");
      setError(customerError);
      return;
    }

    let creditCard: CreditCardInput | undefined;

    if (isCard) {
      const { month, year } = splitExpiry(card.expiry);
      creditCard = {
        holderName: card.holderName,
        number: card.number,
        expiryMonth: month,
        expiryYear: year,
        ccv: card.ccv,
      };

      const cardError = validateCreditCard(creditCard, holder);
      if (cardError) {
        setError(cardError);
        return;
      }
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(establishmentId ? { establishment_id: establishmentId } : {}),
          billingType,
          cycle: cyclePrice.id,
          ...(coupon?.couponCode ? { couponCode: coupon.couponCode } : {}),
          customer,
          ...(creditCard ? { creditCard, creditCardHolderInfo: holder } : {}),
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Não foi possível concluir a contratação."
        );
      }

      const checkout = data as unknown as CheckoutResponse;
      setResult(checkout);

      const paid = isPaidPaymentStatus(checkout.paymentStatus);

      // O servidor reaproveita a cobrança já aberta da loja em vez de criar uma
      // segunda assinatura; avisa quando a forma de pagamento é outra.
      if (!paid && checkout.billingType !== billingType) {
        setNotice(
          `Já existia uma cobrança deste plano em aberto (${BILLING_TYPE_LABELS[checkout.billingType]}), então ela foi mantida para não gerar uma segunda assinatura.`
        );
      }

      if (paid) {
        setIsPaid(true);
        onConfirmed();
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Não foi possível concluir a contratação."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Copia o Pix Copia e Cola para a área de transferência. */
  const handleCopyPix = async () => {
    const payload = result?.pix?.payload;
    if (!payload) return;

    try {
      await navigator.clipboard.writeText(payload);
      setPixCopied(true);
      window.setTimeout(() => setPixCopied(false), 3000);
    } catch {
      setError(
        "Não foi possível copiar automaticamente. Selecione o código Pix e copie manualmente."
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-gray-950/80 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-title"
        className="flex max-h-[100dvh] w-full flex-col rounded-t-2xl border border-gray-800 bg-gray-900 shadow-xl sm:max-h-[90vh] sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-800 px-5 py-4">
          <div className="min-w-0">
            <h2 id="checkout-title" className="text-lg font-bold text-white">
              {isPaid
                ? "Pagamento confirmado"
                : result
                  ? "Finalize o pagamento"
                  : "Assinar plano"}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {planName} · Cobrança {cyclePrice.label.toLowerCase()} (
              {cyclePrice.durationLabel})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="-mr-1 -mt-1 rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-800 hover:text-gray-200"
          >
            <svg
              aria-hidden="true"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        {!result && (
          <ol className="flex items-center gap-2 border-b border-gray-800 px-5 py-3 text-xs font-semibold">
            <li
              className={
                step === "billing" ? "text-yellow-300" : "text-emerald-400"
              }
            >
              1. Seus dados
            </li>
            <span aria-hidden="true" className="h-px flex-1 bg-gray-800" />
            <li
              className={step === "payment" ? "text-yellow-300" : "text-gray-500"}
            >
              2. Pagamento
            </li>
          </ol>
        )}

        {result ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {isPaid ? (
                <div className="space-y-3 py-6 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                    <svg
                      aria-hidden="true"
                      className="h-7 w-7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      viewBox="0 0 24 24"
                    >
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  </div>
                  <p className="text-base font-semibold text-white">
                    Pagamento confirmado!
                  </p>
                  <p className="mx-auto max-w-xs text-sm text-gray-400">
                    O {planName} está ativo e todos os recursos do painel foram
                    liberados.
                  </p>
                </div>
              ) : result.pix ? (
                <div className="space-y-4">
                  {result.pix.encodedImage && (
                    <div className="mx-auto w-fit rounded-2xl bg-white p-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`data:image/png;base64,${result.pix.encodedImage}`}
                        alt="QR Code Pix para pagamento da assinatura"
                        className="h-48 w-48"
                      />
                    </div>
                  )}

                  {result.pix.payload && (
                    <div>
                      <label
                        htmlFor="checkout-pix-payload"
                        className={LABEL_CLASS}
                      >
                        Pix Copia e Cola
                      </label>
                      <div className="flex items-start gap-2">
                        <textarea
                          id="checkout-pix-payload"
                          readOnly
                          rows={3}
                          value={result.pix.payload}
                          onFocus={(event) => event.currentTarget.select()}
                          className={`${INPUT_CLASS} font-mono text-xs`}
                        />
                        <button
                          type="button"
                          onClick={handleCopyPix}
                          className="shrink-0 rounded-xl border border-gray-700 px-3 py-2.5 text-xs font-semibold text-gray-200 transition hover:bg-gray-800"
                        >
                          {pixCopied ? "Copiado!" : "Copiar"}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 rounded-lg border border-yellow-400/25 bg-yellow-400/10 px-3 py-2 text-xs font-medium text-yellow-200">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 animate-pulse rounded-full bg-yellow-300"
                    />
                    Aguardando a confirmação do Pix...
                  </div>

                  <p className="text-xs text-gray-500">
                    {pixExpiration
                      ? `O código é válido até ${pixExpiration}. `
                      : ""}
                    A liberação do painel é automática assim que o pagamento é
                    identificado.
                  </p>
                </div>
              ) : result.boleto ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-gray-800 bg-gray-950/40 px-4 py-3">
                    <p className="text-sm font-semibold text-gray-100">
                      Boleto gerado
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      {boletoDueDate ? `Vencimento em ${boletoDueDate}. ` : ""}
                      A compensação bancária pode levar até 2 dias úteis; o
                      acesso é liberado automaticamente depois dela.
                    </p>
                  </div>

                  {boletoUrl && (
                    <a
                      href={boletoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-xl bg-yellow-400 px-4 py-2.5 text-center text-sm font-bold text-gray-950 transition hover:bg-yellow-300"
                    >
                      Abrir boleto
                    </a>
                  )}

                  <div className="flex items-center gap-2 rounded-lg border border-yellow-400/25 bg-yellow-400/10 px-3 py-2 text-xs font-medium text-yellow-200">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 animate-pulse rounded-full bg-yellow-300"
                    />
                    Aguardando o pagamento do boleto...
                  </div>
                </div>
              ) : (
                <div className="space-y-3 py-4 text-center">
                  <div
                    aria-hidden="true"
                    className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-gray-700 border-t-yellow-400"
                  />
                  <p className="text-sm font-semibold text-white">
                    {result.paymentStatus === "PENDING" ||
                    result.paymentStatus === "AWAITING_RISK_ANALYSIS"
                      ? "Pagamento em análise"
                      : result.billingType === "CREDIT_CARD"
                        ? "Validando o cartão"
                        : "Estamos gerando sua cobrança"}
                  </p>
                  <p className="mx-auto max-w-xs text-xs text-gray-400">
                    Isso costuma levar poucos segundos. Esta tela é atualizada
                    automaticamente.
                  </p>
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400"
                >
                  {error}
                </p>
              )}

              {notice && (
                <p
                  role="status"
                  className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-sm font-medium text-yellow-200"
                >
                  {notice}
                </p>
              )}

              {!isPaid && lastCheckLabel && (
                <p className="text-center text-[11px] text-gray-600">
                  Última verificação: {lastCheckLabel}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-800 px-5 py-4">
              {isPaid ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 sm:w-auto"
                >
                  Ir para o painel
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800"
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    onClick={handleManualCheck}
                    disabled={isChecking}
                    className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isChecking ? "Verificando..." : "Já paguei"}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : step === "billing" ? (
          <form
            onSubmit={handleBillingNext}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div>
                <label htmlFor="checkout-name" className={LABEL_CLASS}>
                  Nome completo
                </label>
                <input
                  id="checkout-name"
                  type="text"
                  autoComplete="name"
                  placeholder="Como no seu documento"
                  value={customer.name}
                  onChange={(event) => updateCustomer("name", event.target.value)}
                  className={INPUT_CLASS}
                />
              </div>

              <div>
                <label htmlFor="checkout-email" className={LABEL_CLASS}>
                  E-mail
                </label>
                <input
                  id="checkout-email"
                  type="email"
                  autoComplete="email"
                  placeholder="voce@restaurante.com.br"
                  value={customer.email}
                  onChange={(event) => updateCustomer("email", event.target.value)}
                  className={INPUT_CLASS}
                />
                <p className="mt-1 text-xs text-gray-500">
                  A nota fiscal e os avisos de cobrança vão para este e-mail.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="checkout-document" className={LABEL_CLASS}>
                    CPF ou CNPJ
                  </label>
                  <input
                    id="checkout-document"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="000.000.000-00"
                    value={customer.cpfCnpj}
                    onChange={(event) =>
                      updateCustomer(
                        "cpfCnpj",
                        formatCpfCnpjInput(event.target.value)
                      )
                    }
                    className={INPUT_CLASS}
                  />
                </div>

                <div>
                  <label htmlFor="checkout-phone" className={LABEL_CLASS}>
                    Telefone / WhatsApp
                  </label>
                  <input
                    id="checkout-phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="(11) 99999-9999"
                    value={customer.phone}
                    onChange={(event) =>
                      updateCustomer("phone", formatPhoneInput(event.target.value))
                    }
                    className={INPUT_CLASS}
                  />
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400"
                >
                  {error}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-800 px-5 py-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300"
              >
                Continuar
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <fieldset>
                <legend className={LABEL_CLASS}>Forma de pagamento</legend>
                <div className="grid gap-2">
                  {BILLING_TYPES.map((type) => {
                    const selected = billingType === type;

                    return (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setBillingType(type);
                          setError(null);
                          setNotice(null);
                        }}
                        className={`rounded-xl border px-3 py-2.5 text-left transition ${
                          selected
                            ? "border-yellow-400/70 bg-yellow-400/10"
                            : "border-gray-700 bg-gray-950/40 hover:border-gray-600"
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-100">
                            {BILLING_TYPE_LABELS[type]}
                          </span>
                          {selected && (
                            <span className="rounded-full bg-yellow-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-950">
                              Selecionado
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-gray-500">
                          {PAYMENT_HINTS[type]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {isCard ? (
                <>
                  <div>
                    <label htmlFor="checkout-card-name" className={LABEL_CLASS}>
                      Nome impresso no cartão
                    </label>
                    <input
                      id="checkout-card-name"
                      type="text"
                      autoComplete="cc-name"
                      placeholder="Como está no cartão"
                      value={card.holderName}
                      onChange={(event) =>
                        setCard((previous) => ({
                          ...previous,
                          holderName: event.target.value,
                        }))
                      }
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label htmlFor="checkout-card-number" className={LABEL_CLASS}>
                      Número do cartão
                    </label>
                    <input
                      id="checkout-card-number"
                      type="text"
                      inputMode="numeric"
                      autoComplete="cc-number"
                      placeholder="0000 0000 0000 0000"
                      value={card.number}
                      onChange={(event) =>
                        setCard((previous) => ({
                          ...previous,
                          number: formatCardNumberInput(event.target.value),
                        }))
                      }
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="checkout-card-expiry" className={LABEL_CLASS}>
                        Validade
                      </label>
                      <input
                        id="checkout-card-expiry"
                        type="text"
                        inputMode="numeric"
                        autoComplete="cc-exp"
                        placeholder="MM/AA"
                        value={card.expiry}
                        onChange={(event) =>
                          setCard((previous) => ({
                            ...previous,
                            expiry: formatExpiryInput(event.target.value),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </div>

                    <div>
                      <label htmlFor="checkout-card-ccv" className={LABEL_CLASS}>
                        CVV
                      </label>
                      <input
                        id="checkout-card-ccv"
                        type="text"
                        inputMode="numeric"
                        autoComplete="cc-csc"
                        maxLength={4}
                        placeholder="123"
                        value={card.ccv}
                        onChange={(event) =>
                          setCard((previous) => ({
                            ...previous,
                            ccv: onlyDigits(event.target.value).slice(0, 4),
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </div>
                  </div>

                  <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-950/30 px-3 py-3">
                    <p className="text-xs font-semibold text-gray-300">
                      Endereço de cobrança do titular
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label
                          htmlFor="checkout-postal-code"
                          className={LABEL_CLASS}
                        >
                          CEP
                        </label>
                        <input
                          id="checkout-postal-code"
                          type="text"
                          inputMode="numeric"
                          autoComplete="postal-code"
                          placeholder="00000-000"
                          value={holder.postalCode}
                          onChange={(event) =>
                            setHolder((previous) => ({
                              ...previous,
                              postalCode: formatPostalCodeInput(
                                event.target.value
                              ),
                            }))
                          }
                          className={INPUT_CLASS}
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="checkout-address-number"
                          className={LABEL_CLASS}
                        >
                          Número
                        </label>
                        <input
                          id="checkout-address-number"
                          type="text"
                          autoComplete="off"
                          placeholder="123"
                          value={holder.addressNumber}
                          onChange={(event) =>
                            setHolder((previous) => ({
                              ...previous,
                              addressNumber: event.target.value,
                            }))
                          }
                          className={INPUT_CLASS}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">
                      Usados apenas na análise antifraude. Os dados do cartão não
                      são armazenados por nós.
                    </p>
                  </div>
                </>
              ) : (
                <p className="rounded-lg border border-gray-800 bg-gray-950/40 px-3 py-2.5 text-xs text-gray-400">
                  {billingType === "PIX"
                    ? "Geramos um QR Code na hora. A confirmação costuma levar poucos segundos após o pagamento."
                    : "O boleto é emitido na hora. O acesso é liberado após a compensação bancária (até 2 dias úteis)."}
                </p>
              )}

              <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-950/30 px-3 py-3">
                <div>
                  <label htmlFor="checkout-coupon" className={LABEL_CLASS}>
                    Cupom de desconto
                  </label>
                  <div className="flex items-start gap-2">
                    <input
                      id="checkout-coupon"
                      type="text"
                      autoComplete="off"
                      placeholder="Ex.: BEMVINDO10"
                      value={couponInput}
                      onChange={(event) => {
                        setCouponInput(event.target.value.toUpperCase());
                        setCouponError(null);
                      }}
                      disabled={
                        Boolean(coupon) || isCouponChecking || isSubmitting
                      }
                      className={`${INPUT_CLASS} font-mono uppercase tracking-wide disabled:opacity-60`}
                    />
                    {coupon ? (
                      <button
                        type="button"
                        onClick={handleRemoveCoupon}
                        disabled={isSubmitting}
                        className="shrink-0 rounded-xl border border-gray-700 px-3 py-2.5 text-xs font-bold text-gray-200 transition hover:bg-gray-800 disabled:opacity-60"
                      >
                        Remover
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleApplyCoupon()}
                        disabled={isCouponChecking || isSubmitting}
                        className="shrink-0 rounded-xl border border-yellow-400/60 bg-yellow-400/10 px-3 py-2.5 text-xs font-bold text-yellow-200 transition hover:bg-yellow-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isCouponChecking ? "Validando..." : "Aplicar"}
                      </button>
                    )}
                  </div>

                  {couponError && (
                    <p
                      role="alert"
                      className="mt-1.5 text-xs font-medium text-red-400"
                    >
                      {couponError}
                    </p>
                  )}

                  {coupon && (
                    <p className="mt-1.5 text-xs font-medium text-emerald-400">
                      Cupom {coupon.couponCode} aplicado
                      {coupon.discountLabel
                        ? ` (${coupon.discountLabel})`
                        : ""}
                      .
                    </p>
                  )}
                </div>

                <dl className="space-y-1.5 border-t border-gray-800 pt-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-gray-400">
                      Plano {cyclePrice.label.toLowerCase()} (
                      {cyclePrice.durationLabel})
                    </dt>
                    <dd className="flex items-baseline gap-2 font-semibold tabular-nums text-gray-200">
                      {hasCycleDiscount && (
                        <span className="text-xs font-medium text-gray-500 line-through">
                          {cyclePrice.listLabel}
                        </span>
                      )}
                      <span>{cyclePrice.totalLabel}</span>
                    </dd>
                  </div>

                  {couponDiscountCents > 0 && (
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <dt className="text-gray-500">
                        Cupom {coupon?.couponCode}
                      </dt>
                      <dd className="font-medium tabular-nums text-emerald-400">
                        −{formatBRL(couponDiscountCents)}
                      </dd>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 border-t border-gray-800 pt-2">
                    <dt className="text-sm font-semibold text-gray-200">
                      Total {hasCycleDiscount ? "com desconto" : ""}
                    </dt>
                    <dd className="text-base font-bold tabular-nums text-yellow-300">
                      {totalLabel}
                    </dd>
                  </div>
                </dl>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400"
                >
                  {error}
                </p>
              )}

              {notice && (
                <p
                  role="status"
                  className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-sm font-medium text-yellow-200"
                >
                  {notice}
                </p>
              )}
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-gray-800 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => {
                  setStep("billing");
                  setError(null);
                  setNotice(null);
                }}
                disabled={isSubmitting}
                className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:opacity-60"
              >
                Voltar
              </button>

              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting
                  ? "Processando..."
                  : billingType === "PIX"
                    ? "Gerar QR Code Pix"
                    : billingType === "BOLETO"
                      ? "Gerar boleto"
                      : `Pagar ${totalLabel}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
