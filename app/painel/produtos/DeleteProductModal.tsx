"use client";

import { useEffect, useState } from "react";
import type { MenuProduct } from "@/lib/types";

interface DeleteProductModalProps {
  product: MenuProduct;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/** Modal de confirmação de exclusão de um produto. */
export function DeleteProductModal({
  product,
  onCancel,
  onConfirm,
}: DeleteProductModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isDeleting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel, isDeleting]);

  const handleConfirm = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado ao excluir.");
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-red-200 bg-white shadow-xl">
        <div className="px-5 py-5">
          <h2 className="text-lg font-bold text-slate-900">Excluir produto</h2>
          <p className="mt-2 text-sm text-slate-600">
            O produto{" "}
            <span className="font-semibold text-slate-800">{product.name}</span> será
            removido permanentemente do cardápio.
          </p>
          {error && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isDeleting}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isDeleting ? "Excluindo..." : "Excluir"}
          </button>
        </div>
      </div>
    </div>
  );
}
