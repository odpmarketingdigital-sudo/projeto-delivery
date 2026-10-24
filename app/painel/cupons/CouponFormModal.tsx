"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  isValidCouponCode,
  normalizeCouponCode,
  toCouponNumber,
  type CouponDiscountType,
  type CouponRecord,
} from "@/lib/coupons";

interface CouponFormModalProps {
  establishmentId: string;
  /** Indica se o requisitante é super_admin (define se envia establishment_id). */
  isSuperAdmin: boolean;
  /** Cupom em edição (null = criação). */
  editing: CouponRecord | null;
  onClose: () => void;
  onSubmitDone: () => void;
}

interface CouponFormState {
  code: string;
  discount_type: CouponDiscountType;
  discount_value: string;
  min_order_value: string;
  usage_limit: string;
  active: boolean;
}

const EMPTY_FORM: CouponFormState = {
  code: "",
  discount_type: "percentage",
  discount_value: "",
  min_order_value: "",
  usage_limit: "",
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

function toFormState(editing: CouponRecord | null): CouponFormState {
  if (!editing) return EMPTY_FORM;
  return {
    code: editing.code,
    discount_type: editing.discount_type,
    discount_value: String(toCouponNumber(editing.discount_value)).replace(
      ".",
      ","
    ),
    min_order_value:
      editing.min_order_value == null
        ? ""
        : String(toCouponNumber(editing.min_order_value)).replace(".", ","),
    usage_limit:
      editing.usage_limit == null
        ? ""
        : String(toCouponNumber(editing.usage_limit)),
    active: editing.active,
  };
}

const inputClass =
  "w-full rounded-xl border border-gray-700 bg-gray-900/60 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60";

/**
 * Modal "Novo cupom" / "Editar cupom".
 * Envia POST (criar) ou PUT (editar) para /api/coupons.
 */
export function CouponFormModal({
  establishmentId,
  isSuperAdmin,
  editing,
  onClose,
  onSubmitDone,
}: CouponFormModalProps) {
  const [form, setForm] = useState<CouponFormState>(() =>
    toFormState(editing)
  );
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
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, isSubmitting]);

  const set = (patch: Partial<CouponFormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);

    const code = normalizeCouponCode(form.code);
    if (!isValidCouponCode(code)) {
      setError(
        "Informe um código válido com 3 a 40 caracteres (letras, números, hífen ou sublinhado)."
      );
      return;
    }

    const discountValue = parseDecimal(form.discount_value);
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      setError("Informe um valor de desconto maior que zero.");
      return;
    }
    if (form.discount_type === "percentage" && discountValue > 100) {
      setError("O desconto percentual não pode ultrapassar 100%.");
      return;
    }

    let minOrderValue: number | null = null;
    if (form.min_order_value.trim()) {
      minOrderValue = parseDecimal(form.min_order_value);
      if (!Number.isFinite(minOrderValue) || minOrderValue < 0) {
        setError("O pedido mínimo deve ser um valor válido (zero ou mais).");
        return;
      }
    }

    let usageLimit: number | null = null;
    if (form.usage_limit.trim()) {
      usageLimit = Number(form.usage_limit);
      if (!Number.isInteger(usageLimit) || usageLimit < 1) {
        setError("O limite de usos deve ser um número inteiro maior que zero.");
        return;
      }
    }

    const payload = {
      code,
      discount_type: form.discount_type,
      discount_value: discountValue,
      min_order_value: minOrderValue,
      usage_limit: usageLimit,
      active: form.active,
    };

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/coupons", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing
            ? { id: editing.id, ...payload }
            : {
                ...(isSuperAdmin ? { establishment_id: establishmentId } : {}),
                ...payload,
              }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao salvar o cupom.");
      }
      onSubmitDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-900 shadow-xl">
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-bold text-white">
            {editing ? "Editar cupom" : "Novo cupom"}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {editing
              ? "Atualize as regras e a disponibilidade do cupom."
              : "Crie um código de desconto para usar no checkout."}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4"
        >
          <div>
            <label
              htmlFor="coupon-code"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              Código
            </label>
            <input
              id="coupon-code"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="Ex.: DESCONTO10"
              value={form.code}
              onChange={(event) =>
                set({ code: event.target.value.toUpperCase() })
              }
              className={`${inputClass} uppercase tracking-wide placeholder:normal-case`}
            />
            <p className="mt-1 text-xs text-gray-500">
              Salvo em caixa alta. Único por estabelecimento.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="coupon-type"
                className="mb-1.5 block text-sm font-semibold text-gray-200"
              >
                Tipo de desconto
              </label>
              <select
                id="coupon-type"
                value={form.discount_type}
                onChange={(event) =>
                  set({
                    discount_type: event.target.value as CouponDiscountType,
                  })
                }
                className={inputClass}
              >
                <option value="percentage">Percentual (%)</option>
                <option value="fixed">Valor fixo (R$)</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="coupon-value"
                className="mb-1.5 block text-sm font-semibold text-gray-200"
              >
                {form.discount_type === "percentage"
                  ? "Desconto (%)"
                  : "Desconto (R$)"}
              </label>
              <input
                id="coupon-value"
                type="text"
                inputMode="decimal"
                placeholder={
                  form.discount_type === "percentage" ? "Ex.: 10" : "Ex.: 5,00"
                }
                value={form.discount_value}
                onChange={(event) =>
                  set({ discount_value: event.target.value })
                }
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="coupon-min"
                className="mb-1.5 block text-sm font-semibold text-gray-200"
              >
                Pedido mínimo (R$){" "}
                <span className="font-normal text-gray-500">(opcional)</span>
              </label>
              <input
                id="coupon-min"
                type="text"
                inputMode="decimal"
                placeholder="Ex.: 30,00"
                value={form.min_order_value}
                onChange={(event) =>
                  set({ min_order_value: event.target.value })
                }
                className={inputClass}
              />
            </div>

            <div>
              <label
                htmlFor="coupon-limit"
                className="mb-1.5 block text-sm font-semibold text-gray-200"
              >
                Limite de usos{" "}
                <span className="font-normal text-gray-500">(opcional)</span>
              </label>
              <input
                id="coupon-limit"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="Ilimitado"
                value={form.usage_limit}
                onChange={(event) =>
                  set({ usage_limit: event.target.value })
                }
                className={inputClass}
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-800 bg-gray-900/40 p-3.5">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(event) => set({ active: event.target.checked })}
              className="mt-0.5 h-4 w-4 accent-yellow-400"
            />
            <span>
              <span className="block text-sm font-semibold text-gray-200">
                Cupom ativo
              </span>
              <span className="block text-xs text-gray-500">
                Desmarque para pausar o cupom sem excluí-lo.
              </span>
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

          <div className="flex items-center justify-end gap-3 border-t border-gray-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-70"
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
