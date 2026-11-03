"use client";

import { useEffect, useState } from "react";

/**
 * Confirmação do cancelamento da assinatura.
 *
 * Passo único e explícito: lista o que acontece ao cancelar (cobranças param,
 * painel bloqueado e cardápio público fora do ar) para evitar clique acidental.
 * A chamada de rede fica com a tela (`onConfirm`); o modal só exibe o estado de
 * envio e a mensagem de erro devolvida pela API.
 */

interface CancelSubscriptionModalProps {
  /** Nome da loja (quando conhecido) exibido na confirmação. */
  establishmentName: string | null;
  /** Plano/ciclo contratado, ex.: "Plano Mensal". */
  planLabel: string;
  /** Próxima renovação já formatada (`dd/mm/aaaa`), quando conhecida. */
  renewalLabel: string | null;
  /** `false` em trial/ativação manual: não há cobrança recorrente a parar. */
  hasGatewaySubscription: boolean;
  /** Fecha o modal sem cancelar. */
  onCancel: () => void;
  /**
   * Executa `POST /api/billing/cancel`. Deve rejeitar com `Error` em caso de
   * falha para que a mensagem apareça dentro do próprio modal.
   */
  onConfirm: () => Promise<void>;
}

/** Consequências do cancelamento (mesma lista para assinatura e trial). */
const EFFECTS = [
  "As próximas cobranças são interrompidas — nenhuma fatura nova é gerada.",
  "O painel volta ao modo bloqueado: pedidos, produtos, clientes e dashboard ficam indisponíveis (apenas esta tela e Configurações continuam acessíveis).",
  "O cardápio público é desativado e o link da loja deixa de abrir para os clientes.",
];

export function CancelSubscriptionModal({
  establishmentName,
  planLabel,
  renewalLabel,
  hasGatewaySubscription,
  onCancel,
  onConfirm,
}: CancelSubscriptionModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Trava o scroll do fundo e fecha com ESC (mesmo padrão dos demais modais).
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel, isSubmitting]);

  const handleConfirm = async () => {
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Não foi possível cancelar a assinatura. Tente novamente."
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-subscription-title"
        className="w-full max-w-md rounded-2xl border border-red-200 bg-white shadow-xl"
      >
        <div className="px-5 py-5">
          <h2
            id="cancel-subscription-title"
            className="text-lg font-bold text-slate-900"
          >
            Cancelar assinatura
          </h2>

          <p className="mt-2 text-sm text-slate-600">
            {establishmentName ? (
              <>
                A assinatura{" "}
                <span className="font-semibold text-slate-800">{planLabel}</span>{" "}
                de{" "}
                <span className="font-semibold text-slate-800">
                  {establishmentName}
                </span>{" "}
                será cancelada. Esta ação não pode ser desfeita pelo painel.
              </>
            ) : (
              <>
                A assinatura{" "}
                <span className="font-semibold text-slate-800">{planLabel}</span>{" "}
                será cancelada. Esta ação não pode ser desfeita pelo painel.
              </>
            )}
          </p>

          {hasGatewaySubscription && renewalLabel && (
            <p className="mt-2 text-sm text-slate-600">
              A cobrança recorrente no Asaas é interrompida agora e a renovação
              de {renewalLabel} deixa de ser cobrada.
            </p>
          )}

          <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
            {EFFECTS.map((effect) => (
              <li key={effect} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
                />
                <span>{effect}</span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs text-slate-500">
            Para voltar a vender depois, basta contratar o plano novamente nesta
            tela.
          </p>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-600"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Manter assinatura
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isSubmitting}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSubmitting ? "Cancelando..." : "Confirmar cancelamento"}
          </button>
        </div>
      </div>
    </div>
  );
}
