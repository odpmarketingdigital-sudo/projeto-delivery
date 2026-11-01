import type { OrderStatus } from "@/lib/types";
import { ORDER_STATUS_FLOW } from "@/lib/orderStatus";

/**
 * Rótulos das 4 etapas exibidas ao cliente no acompanhamento do pedido.
 * A ordem é a mesma de `ORDER_STATUS_FLOW` (pendente → preparando → entrega →
 * finalizado); `cancelado` NÃO é etapa do fluxo, é um estado lateral.
 */
const STEP_LABELS: Record<OrderStatus, string> = {
  pendente: "Pedido recebido",
  preparando: "Em preparo",
  entrega: "Saiu para entrega",
  finalizado: "Concluído / Entregue",
  cancelado: "Cancelado",
};

interface OrderProgressStepperProps {
  /** Status atual do pedido (fonte da verdade: `GET /api/order-status`). */
  status: OrderStatus;
}

/**
 * Stepper visual de 4 etapas usado na tela pública `/pedido/[id]`.
 *
 * - Etapas já percorridas + a atual ficam verdes (`#22c55e`).
 * - Etapas futuras ficam cinza.
 * - Pedido cancelado: nenhuma etapa é marcada e um aviso é exibido (o motivo
 *   do cancelamento é renderizado pelo próprio tracker).
 *
 * Componente sem estado/hooks: pode ser usado em Server ou Client Components.
 */
export function OrderProgressStepper({ status }: OrderProgressStepperProps) {
  const currentIndex = ORDER_STATUS_FLOW.indexOf(status);
  const isCancelled = status === "cancelado";

  return (
    <div className="mt-5 border-t border-black/5 pt-4 dark:border-white/10">
      <ol className="flex" aria-label="Etapas do pedido">
        {ORDER_STATUS_FLOW.map((step, index) => {
          // currentIndex = -1 (cancelado) mantém todas as etapas apagadas.
          const isReached = currentIndex >= index;
          const isCurrent = currentIndex === index;

          return (
            <li
              key={step}
              aria-current={isCurrent ? "step" : undefined}
              className="relative flex flex-1 flex-col items-center gap-1.5 text-center"
            >
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[-50%] right-1/2 top-[11px] h-0.5 rounded-full transition-colors ${
                    isReached
                      ? "bg-[#22c55e]"
                      : "bg-slate-300 dark:bg-slate-700"
                  }`}
                />
              )}

              <span
                className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold transition-colors ${
                  isCurrent
                    ? "border-[#22c55e] bg-[#22c55e] text-white ring-4 ring-[#22c55e]/20"
                    : isReached
                      ? "border-[#22c55e] bg-[#22c55e] text-white"
                      : "border-slate-300 bg-white text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500"
                }`}
              >
                {isReached ? (
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3}
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="m4.5 12.75 6 6 9-13.5"
                    />
                  </svg>
                ) : (
                  index + 1
                )}
              </span>

              <span
                className={`px-0.5 text-[11px] font-semibold leading-tight ${
                  isReached
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-slate-400 dark:text-slate-500"
                }`}
              >
                {STEP_LABELS[step]}
              </span>
            </li>
          );
        })}
      </ol>

      {isCancelled && (
        <p className="mt-3 text-center text-xs font-semibold text-red-600 dark:text-red-400">
          Pedido cancelado — acompanhamento encerrado.
        </p>
      )}
    </div>
  );
}
