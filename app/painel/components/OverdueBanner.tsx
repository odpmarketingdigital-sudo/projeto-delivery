"use client";

import Link from "next/link";
import { formatDateBR } from "@/lib/subscriptions";
import {
  describeOverdueDays,
  OVERDUE_GRACE_DAYS,
} from "@/lib/storeEligibility";
import { useSubscription } from "./SubscriptionProvider";

/**
 * Aviso de inadimplência no topo do painel do lojista.
 *
 * Regras:
 *  - só aparece quando o atraso passou da carência (`OVERDUE_GRACE_DAYS`, 15
 *    dias) — o mesmo limite que tira a vitrine do ar em `/[slug]`;
 *  - o botão principal leva direto à fatura no Asaas (`payment_invoice_url`,
 *    gravado pelo webhook/polling). Sem o link, cai na tela de assinatura, onde
 *    o checkout gera uma nova cobrança;
 *  - aparece em todas as telas do painel (inclusive `/painel/assinatura` e a
 *    tela de paywall), para que o lojista sempre tenha o link de pagamento à
 *    mão; fica oculto apenas para super admin (não é dono de loja) e enquanto a
 *    situação da assinatura não foi lida;
 *  - é renderizado pelo `PanelFrame`, acima do conteúdo e do aviso de paywall,
 *    de modo que o motivo do bloqueio apareça também no dashboard.
 */
export function OverdueBanner({
  establishmentId,
}: {
  establishmentId?: string | null;
}) {
  const {
    isLoading,
    isSuperAdmin,
    isSchemaPending,
    isOverdue,
    daysOverdue,
    paymentDueDate,
    paymentInvoiceUrl,
    overdueSuspendedAt,
    storeStatus,
  } = useSubscription();

  if (isLoading || isSuperAdmin || isSchemaPending) return null;
  if (!isOverdue) return null;

  const subscriptionHref = establishmentId
    ? `/painel/assinatura?establishment_id=${encodeURIComponent(establishmentId)}`
    : "/painel/assinatura";

  const dueLabel = formatDateBR(paymentDueDate);
  const overdueLabel = describeOverdueDays(daysOverdue);
  const isSuspended =
    storeStatus === "inativo" || Boolean(overdueSuspendedAt);

  const title = isSuspended
    ? "Sua loja está fora do ar por falta de pagamento"
    : "Sua assinatura está em atraso";

  const description = [
    dueLabel
      ? `A fatura com vencimento em ${dueLabel} está em aberto${
          overdueLabel ? ` ${overdueLabel}` : ""
        }.`
      : `A fatura está em aberto${
          overdueLabel ? ` ${overdueLabel}` : ""
        }.`,
    `O prazo de ${OVERDUE_GRACE_DAYS} dias de carência foi ultrapassado: o link público da loja fica suspenso e os clientes não conseguem acessar o cardápio.`,
    "Regularize o pagamento para voltar a receber pedidos.",
  ].join(" ");

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6 lg:px-8">
      <div
        role="alert"
        className="overflow-hidden rounded-2xl border-2 border-red-300 bg-red-50 shadow-sm"
      >
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-4">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
                Pagamento em atraso
              </span>
              {isSuspended && (
                <span className="inline-flex items-center rounded-full border border-red-300 bg-white px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-red-700">
                  Loja suspensa
                </span>
              )}
            </div>

            <p className="mt-1.5 text-sm font-bold text-red-900">{title}</p>
            <p className="mt-1 text-sm text-red-800">{description}</p>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            {paymentInvoiceUrl ? (
              <a
                href={paymentInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
              >
                Pagar fatura no Asaas
              </a>
            ) : (
              <Link
                href={subscriptionHref}
                className="inline-flex items-center justify-center rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
              >
                Regularizar agora
              </Link>
            )}

            {paymentInvoiceUrl && (
              <Link
                href={subscriptionHref}
                className="text-center text-xs font-semibold text-red-800 underline underline-offset-2 hover:text-red-900"
              >
                Ver detalhes da assinatura
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
