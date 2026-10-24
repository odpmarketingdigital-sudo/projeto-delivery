"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSubscription } from "./SubscriptionProvider";

/**
 * Faixa informativa do estado da assinatura no topo do painel.
 *
 * Regras:
 *  - só aparece quando a loja NÃO está com plano ativo (trial em andamento,
 *    trial expirado, pagamento pendente ou assinatura cancelada);
 *  - fica oculta na própria tela de assinatura (o card do plano já informa o
 *    estado) e para super admin (não é dono de loja);
 *  - durante o carregamento e com a migração de assinaturas pendente não
 *    renderiza nada (evita "piscar" um aviso incorreto).
 *
 * O link "Assinar Agora" leva a `/painel/assinatura`, preservando
 * `?establishment_id=` quando o super admin está operando uma loja específica.
 */
export function TrialBanner({
  establishmentId,
}: {
  establishmentId?: string | null;
}) {
  const pathname = usePathname();
  const { status, daysRemaining, trialEndsAt, isLoading, isSuperAdmin, isSchemaPending } =
    useSubscription();

  if (isLoading || isSuperAdmin || isSchemaPending) return null;
  if (status === "active") return null;
  if (pathname?.startsWith("/painel/assinatura")) return null;

  const isTrialRunning = status === "trialing" && daysRemaining > 0;
  const urgent = !isTrialRunning || daysRemaining <= 3;

  let message: string;
  if (isTrialRunning) {
    message = `Você tem ${daysRemaining} ${
      daysRemaining === 1 ? "dia restante" : "dias restantes"
    } no seu período de testes grátis.`;
  } else if (status === "trialing") {
    message =
      "Seu período de testes grátis expirou. Assine para voltar a acessar pedidos, produtos e dashboard.";
  } else if (status === "past_due") {
    message =
      "Não identificamos o pagamento da sua assinatura. Regularize para não perder o acesso ao painel.";
  } else {
    message =
      "Sua assinatura está cancelada. Reative o plano para voltar a usar todos os recursos.";
  }

  const trialEndLabel = (() => {
    if (!isTrialRunning || !trialEndsAt) return null;
    const end = new Date(trialEndsAt);
    if (!Number.isFinite(end.getTime())) return null;
    return `Termina em ${end.toLocaleDateString("pt-BR")}`;
  })();

  const href = establishmentId
    ? `/painel/assinatura?establishment_id=${encodeURIComponent(establishmentId)}`
    : "/painel/assinatura";

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
      <div
        role="status"
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm ${
          urgent
            ? "border-red-500/40 bg-red-500/10 text-red-100"
            : "border-yellow-400/30 bg-yellow-400/10 text-yellow-100"
        }`}
      >
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
            urgent
              ? "bg-red-500/20 text-red-200"
              : "bg-yellow-400/20 text-yellow-200"
          }`}
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {status === "trialing" ? "Teste grátis" : "Assinatura"}
        </span>

        <p className="min-w-0 flex-1 font-medium">
          {message}
          {trialEndLabel && (
            <span className="ml-1 opacity-75">({trialEndLabel})</span>
          )}
        </p>

        <Link
          href={href}
          className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
            urgent
              ? "bg-red-500 text-white hover:bg-red-400 focus-visible:ring-red-300"
              : "bg-yellow-400 text-gray-950 hover:bg-yellow-300 focus-visible:ring-yellow-200"
          }`}
        >
          Assinar Agora
        </Link>
      </div>
    </div>
  );
}
