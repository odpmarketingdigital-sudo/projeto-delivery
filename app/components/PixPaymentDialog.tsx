"use client";

/**
 * Tela de pagamento PIX Online do checkout (Split Asaas).
 *
 * Recebe a cobrança pronta (QR Code + Copia e Cola) e reflete o ciclo:
 * `loading` → `waiting` → `paid` (ou `error`, com nova tentativa).
 *
 * O cronômetro usa `remainingSeconds` calculado no checkout a partir do
 * `expires_at` devolvido pela API; ao zerar, o cliente pode gerar um novo QR.
 * A confirmação chega pelo webhook do Asaas e é refletida pelo polling de
 * `/api/asaas/pix-payment`.
 */

export type PixPaymentDialogStatus = "loading" | "waiting" | "paid" | "error";

interface PixPaymentDialogProps {
  establishmentName: string;
  total: number;
  /** Rótulo da taxa retida pela plataforma (ex.: "R$ 0,50"). */
  platformFeeLabel: string;
  status: PixPaymentDialogStatus;
  /** Pix Copia e Cola. */
  payload: string | null;
  /** Imagem PNG do QR Code em base64 (sem prefixo `data:`). */
  encodedImage: string | null;
  error: string | null;
  /** Segundos restantes do QR Code (null = sem validade informada). */
  remainingSeconds: number | null;
  copied: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onRetry: () => void;
  onClose: () => void;
}

const formatBRL = (value: number) =>
  `R$ ${value.toFixed(2).replace(".", ",")}`;

function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function PixPaymentDialog({
  establishmentName,
  total,
  platformFeeLabel,
  status,
  payload,
  encodedImage,
  error,
  remainingSeconds,
  copied,
  onCopy,
  onRegenerate,
  onRetry,
  onClose,
}: PixPaymentDialogProps) {
  const expired = status === "waiting" && remainingSeconds === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70 px-4 py-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pix-title"
        className="customer-view-enter max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-gray-700 dark:bg-gray-900 sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
              {establishmentName}
            </p>
            <h2
              id="pix-title"
              className="mt-1 text-lg font-black text-gray-900 dark:text-white"
            >
              {status === "paid" ? "Pagamento confirmado" : "Pague com PIX"}
            </h2>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              Total
            </p>
            <p className="text-xl font-black tabular-nums text-gray-900 dark:text-white">
              {formatBRL(total)}
            </p>
          </div>
        </div>

        {status === "loading" && (
          <div className="mt-8 flex flex-col items-center gap-3 pb-4">
            <svg
              aria-hidden="true"
              className="h-8 w-8 animate-spin text-gray-500 dark:text-gray-300"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth={4}
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-300">
              Gerando a cobrança PIX...
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="mt-5 flex flex-col gap-4">
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
            >
              {error ?? "Não foi possível gerar o PIX. Tente novamente."}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex w-full items-center justify-center rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
            >
              Tentar novamente
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-sm font-semibold text-gray-500 underline dark:text-gray-400"
            >
              Acompanhar pedido sem pagar agora
            </button>
          </div>
        )}

        {status === "waiting" && (
          <div className="mt-5 flex flex-col gap-4">
            {encodedImage ? (
              // Base64 do QR Code devolvido pelo Asaas (PNG).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`data:image/png;base64,${encodedImage}`}
                alt="QR Code do PIX"
                width={220}
                height={220}
                className="mx-auto h-56 w-56 rounded-xl border border-gray-200 bg-white object-contain p-2 dark:border-gray-700"
              />
            ) : (
              <div className="mx-auto flex h-56 w-56 items-center justify-center rounded-xl border border-dashed border-gray-300 text-sm text-gray-400 dark:border-gray-600">
                QR Code indisponível
              </div>
            )}

            {expired ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-center text-sm font-semibold text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                Este QR Code expirou. Gere um novo para concluir o pagamento.
              </p>
            ) : remainingSeconds !== null ? (
              <p className="text-center text-sm text-gray-500 dark:text-gray-300">
                O QR Code expira em{" "}
                <span className="font-bold tabular-nums text-gray-900 dark:text-white">
                  {formatRemaining(remainingSeconds)}
                </span>
              </p>
            ) : null}

            <button
              type="button"
              onClick={expired ? onRegenerate : onCopy}
              disabled={!payload}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:focus:ring-yellow-400 dark:focus:ring-offset-gray-900"
            >
              {copied && !expired
                ? "Copiado! ✓"
                : expired
                  ? "Gerar novo QR Code"
                  : "Copiar chave PIX"}
            </button>

            <div
              role="status"
              aria-live="polite"
              className="flex items-center justify-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300"
            >
              <span className="h-2 w-2 animate-ping rounded-full bg-amber-500" />
              Aguardando pagamento...
            </div>

            <p className="rounded-xl bg-gray-50 px-3 py-2 text-center text-xs leading-relaxed text-gray-500 dark:bg-gray-800/60 dark:text-gray-300">
              Abra o app do seu banco, escolha PIX e pague com o QR Code ou com o
              Copia e Cola. A confirmação é automática.
            </p>
          </div>
        )}

        {status === "paid" && (
          <div className="mt-6 flex flex-col items-center gap-3 pb-2 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400">
              <svg
                aria-hidden="true"
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m4.5 12.75 6 6 9-13.5"
                />
              </svg>
            </span>
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
              Recebemos o seu pagamento!
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Estamos te levando para o acompanhamento do pedido...
            </p>
          </div>
        )}

        <p className="mt-5 border-t border-gray-200 pt-3 text-[11px] leading-relaxed text-gray-400 dark:border-gray-700 dark:text-gray-500">
          Pagamento processado pelo Asaas. A Ipepper retém {platformFeeLabel} por
          pedido online; o restante é repassado à loja.
        </p>

        {status === "waiting" && (
          <button
            type="button"
            onClick={onClose}
            className="mt-3 w-full text-center text-sm font-semibold text-gray-500 underline dark:text-gray-400"
          >
            Fechar e acompanhar pedido
          </button>
        )}
      </div>
    </div>
  );
}
