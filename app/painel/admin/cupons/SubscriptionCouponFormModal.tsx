"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  SUBSCRIPTION_COUPON_DISCOUNT_TYPE_LABELS,
  SUBSCRIPTION_COUPON_DISCOUNT_TYPES,
  normalizeSubscriptionCouponCode,
  toSubscriptionCouponNumber,
  validateSubscriptionCouponFields,
  type SubscriptionCouponDiscountType,
  type SubscriptionCouponRecord,
} from "@/lib/subscription-coupons";

interface SubscriptionCouponFormModalProps {
  /** Cupom em edição (null = criação). */
  editing: SubscriptionCouponRecord | null;
  onClose: () => void;
  /** Chamado após salvar (a lista é recarregada pelo pai). */
  onSaved: () => void;
}

interface CouponFormState {
  code: string;
  discountType: SubscriptionCouponDiscountType;
  discountValue: string;
  usageLimit: string;
  active: boolean;
}

const EMPTY_FORM: CouponFormState = {
  code: "",
  discountType: "percentage",
  discountValue: "",
  usageLimit: "",
  active: true,
};

/** Converte "10,5" / "10.5" / "1.000,50" para número. */
function parseDecimal(raw: string): number {
  const cleaned = raw.trim();
  if (!cleaned) return Number.NaN;
  if (cleaned.includes(",")) {
    return Number(cleaned.replace(/\./g, "").replace(",", "."));
  }
  return Number(cleaned);
}

function toFormState(editing: SubscriptionCouponRecord | null): CouponFormState {
  if (!editing) return EMPTY_FORM;
  return {
    code: editing.code,
    discountType: editing.discount_type,
    discountValue: String(
      toSubscriptionCouponNumber(editing.discount_value)
    ).replace(".", ","),
    usageLimit:
      editing.usage_limit == null
        ? ""
        : String(toSubscriptionCouponNumber(editing.usage_limit)),
    active: editing.active,
  };
}

const inputClass =
  "w-full rounded-xl border border-gray-700 bg-gray-900/60 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60";
const labelClass = "mb-1.5 block text-sm font-semibold text-gray-200";

/**
 * Modal "Novo cupom de assinatura" / "Editar cupom de assinatura".
 *
 * Envia POST (criar) ou PATCH (editar) para `/api/admin/subscription-coupons`.
 * A validação usa a MESMA função do servidor
 * (`validateSubscriptionCouponFields`), inclusive para valor fixo em reais e
 * limite de usos.
 */
export function SubscriptionCouponFormModal({
  editing,
  onClose,
  onSaved,
}: SubscriptionCouponFormModalProps) {
  const [form, setForm] = useState<CouponFormState>(() => toFormState(editing));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Ressincroniza se o cupom em edição mudar com o modal aberto.
  const [prevEditing, setPrevEditing] = useState(editing);
  if (editing !== prevEditing) {
    setPrevEditing(editing);
    setForm(toFormState(editing));
  }

  // Fecha com ESC e trava o scroll do body enquanto aberto.
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

  const set = (patch: Partial<CouponFormState>) =>
    setForm((previous) => ({ ...previous, ...patch }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);

    const discountValue = parseDecimal(form.discountValue);
    const usageLimit = form.usageLimit.trim()
      ? Number(form.usageLimit.trim())
      : null;

    const { fields, error: validationError } =
      validateSubscriptionCouponFields({
        code: normalizeSubscriptionCouponCode(form.code),
        discount_type: form.discountType,
        discount_value: Number.isFinite(discountValue) ? discountValue : 0,
        usage_limit: usageLimit,
        active: form.active,
      });

    if (!fields) {
      setError(validationError ?? "Confira os dados do cupom.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/admin/subscription-coupons", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...fields } : fields),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Não foi possível salvar o cupom."
        );
      }

      onSaved();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Não foi possível salvar o cupom."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const usedCount = toSubscriptionCouponNumber(editing?.used_count ?? 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-900 shadow-xl">
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-bold text-white">
            {editing ? "Editar cupom de assinatura" : "Novo cupom de assinatura"}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            O desconto é aplicado sobre o total do período (mensal, semestral ou
            anual) no checkout da assinatura.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
            <div>
              <label htmlFor="sub-coupon-code" className={labelClass}>
                Código
              </label>
              <input
                id="sub-coupon-code"
                type="text"
                autoComplete="off"
                placeholder="Ex.: ANUAL10"
                value={form.code}
                onChange={(event) =>
                  set({ code: event.target.value.toUpperCase() })
                }
                className={`${inputClass} font-mono uppercase tracking-wide`}
              />
              <p className="mt-1 text-xs text-gray-500">
                3 a 40 caracteres — letras, números, hífen ou sublinhado.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="sub-coupon-type" className={labelClass}>
                  Tipo de desconto
                </label>
                <select
                  id="sub-coupon-type"
                  value={form.discountType}
                  onChange={(event) =>
                    set({
                      discountType: event.target
                        .value as SubscriptionCouponDiscountType,
                    })
                  }
                  className={inputClass}
                >
                  {SUBSCRIPTION_COUPON_DISCOUNT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {SUBSCRIPTION_COUPON_DISCOUNT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="sub-coupon-value" className={labelClass}>
                  {form.discountType === "percentage"
                    ? "Desconto (%)"
                    : "Desconto (R$)"}
                </label>
                <input
                  id="sub-coupon-value"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={form.discountType === "percentage" ? "10" : "20,00"}
                  value={form.discountValue}
                  onChange={(event) => set({ discountValue: event.target.value })}
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor="sub-coupon-usage" className={labelClass}>
                Limite de usos
              </label>
              <input
                id="sub-coupon-usage"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="Ilimitado"
                value={form.usageLimit}
                onChange={(event) => set({ usageLimit: event.target.value })}
                className={inputClass}
              />
              <p className="mt-1 text-xs text-gray-500">
                Deixe em branco para usos ilimitados.
                {editing ? ` Já utilizado ${usedCount}×.` : ""}
              </p>
            </div>

            <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2.5">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => set({ active: event.target.checked })}
                className="h-4 w-4 rounded border-gray-600 bg-gray-900 text-yellow-400 focus:ring-yellow-400/40"
              />
              <span className="text-sm font-medium text-gray-200">
                Cupom ativo (pode ser usado no checkout)
              </span>
            </label>

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
              disabled={isSubmitting}
              className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting
                ? "Salvando..."
                : editing
                  ? "Salvar alterações"
                  : "Criar cupom"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
