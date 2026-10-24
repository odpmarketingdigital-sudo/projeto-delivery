"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { MenuAddon, MenuProduct } from "@/lib/types";
import { sortByOrder } from "@/lib/menuOrder";

interface AddonsModalProps {
  establishmentId: string;
  /** Indica se o requisitante é super_admin (define se envia establishment_id). */
  isSuperAdmin: boolean;
  /** Produto dono dos adicionais exibidos. */
  product: MenuProduct;
  /** Adicionais do estabelecimento (o modal filtra por `product_id`). */
  addons: MenuAddon[];
  onClose: () => void;
  /** Chamado após criar/pausar/excluir para recarregar o cardápio. */
  onChanged: () => void;
}

/** Formata número como BRL (ex: 5 → "R$ 5,00"). */
function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

/** Converte "5,50" / "5.50" para número (aceita ambos). */
function parsePrice(raw: string): number {
  const normalized = raw.trim().replace(/\./g, "").replace(",", ".");
  return Number(normalized);
}

/**
 * Modal de Gestão de Adicionais de um produto: criar (marcando se é
 * obrigatório), alternar obrigatório/opcional (is_required), pausar (is_active)
 * e excluir (ex: "Bacon +R$ 5,00").
 *
 * Consome /api/addons (a listagem já vem da página via GET /api/products; aqui
 * POST/PUT/DELETE).
 */
export function AddonsModal({
  establishmentId,
  isSuperAdmin,
  product,
  addons,
  onClose,
  onChanged,
}: AddonsModalProps) {
  const [items, setItems] = useState<MenuAddon[]>(() =>
    sortByOrder(addons.filter((a) => a.product_id === product.id))
  );
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newRequired, setNewRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Sincroniza se a lista externa mudar (ex.: recarga do cardápio). Ajuste
  // durante o render, evitando um efeito só para refletir a prop.
  const [prevAddons, setPrevAddons] = useState(addons);
  if (addons !== prevAddons) {
    setPrevAddons(addons);
    setItems(sortByOrder(addons.filter((a) => a.product_id === product.id)));
  }

  // Fecha com ESC e trava o scroll do body enquanto aberto.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handleError = (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback;

  /** Cria um adicional para o produto atual (POST). */
  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (isCreating) return;
    const name = newName.trim();
    const price = parsePrice(newPrice || "0");
    if (!name) {
      setError("Informe o nome do adicional.");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setError("Informe um preço válido (ex: 5,00). Use 0 para gratuito.");
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        product_id: product.id,
        name,
        price,
        is_required: newRequired,
      };
      if (isSuperAdmin) body.establishment_id = establishmentId;
      const res = await fetch("/api/addons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao criar o adicional.");
      setNewName("");
      setNewPrice("");
      setNewRequired(false);
      onChanged();
    } catch (err) {
      setError(handleError(err, "Erro ao criar adicional."));
    } finally {
      setIsCreating(false);
    }
  };

  /** Pausa/ativa um adicional (PUT com apenas { id, is_active }). */
  const handleToggle = async (addon: MenuAddon) => {
    if (busyId) return;
    const previous = addon.is_active;
    // Otimista: reflete imediatamente na lista.
    setItems((prev) =>
      prev.map((a) => (a.id === addon.id ? { ...a, is_active: !previous } : a))
    );
    setBusyId(addon.id);
    setError(null);
    try {
      const res = await fetch("/api/addons", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: addon.id, is_active: !previous }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao atualizar o adicional.");
      onChanged();
    } catch (err) {
      // Reverte a mudança otimista.
      setItems((prev) =>
        prev.map((a) => (a.id === addon.id ? { ...a, is_active: previous } : a))
      );
      setError(handleError(err, "Erro ao atualizar adicional."));
    } finally {
      setBusyId(null);
    }
  };

  /** Exclui um adicional (DELETE). */
  const handleDelete = async (addon: MenuAddon) => {
    if (busyId) return;
    setBusyId(addon.id);
    setError(null);
    try {
      const res = await fetch("/api/addons", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: addon.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao excluir o adicional.");
      setItems((prev) => prev.filter((a) => a.id !== addon.id));
      onChanged();
    } catch (err) {
      setError(handleError(err, "Erro ao excluir adicional."));
    } finally {
      setBusyId(null);
    }
  };

  /** Alterna `is_required` (obrigatório/opcional) de um adicional (PUT). */
  const handleToggleRequired = async (addon: MenuAddon) => {
    if (busyId) return;
    const previous = addon.is_required;
    // Otimista: reflete imediatamente na lista.
    setItems((prev) =>
      prev.map((a) =>
        a.id === addon.id ? { ...a, is_required: !previous } : a
      )
    );
    setBusyId(addon.id);
    setError(null);
    try {
      const res = await fetch("/api/addons", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: addon.id, is_required: !previous }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao atualizar o adicional.");
      onChanged();
    } catch (err) {
      // Reverte a mudança otimista.
      setItems((prev) =>
        prev.map((a) =>
          a.id === addon.id ? { ...a, is_required: previous } : a
        )
      );
      setError(handleError(err, "Erro ao atualizar adicional."));
    } finally {
      setBusyId(null);
    }
  };

  const inputClass =
    "rounded-xl border border-gray-700 bg-gray-900/60 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60";


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-gray-800 bg-gray-900 shadow-xl">
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-bold text-white">Adicionais</h2>
          <p className="mt-0.5 text-sm text-gray-400">
            Opcionais de{" "}
            <span className="font-semibold text-yellow-300">{product.name}</span>
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Formulário de criação */}
          <form onSubmit={handleCreate} className="flex items-end gap-2">
            <div className="flex-1">
              <label
                htmlFor="addon-name"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500"
              >
                Nome
              </label>
              <input
                id="addon-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ex: Bacon"
                disabled={isCreating}
                className={`w-full ${inputClass} disabled:opacity-60`}
              />
            </div>
            <div className="w-28">
              <label
                htmlFor="addon-price"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500"
              >
                Preço (R$)
              </label>
              <input
                id="addon-price"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                inputMode="decimal"
                placeholder="5,00"
                disabled={isCreating}
                className={`w-full ${inputClass} disabled:opacity-60`}
              />
            </div>
            <label className="flex shrink-0 cursor-pointer select-none items-center gap-2 pb-2.5 text-xs font-semibold text-gray-300">
              <input
                type="checkbox"
                checked={newRequired}
                onChange={(e) => setNewRequired(e.target.checked)}
                disabled={isCreating}
                className="h-4 w-4 cursor-pointer rounded border-gray-600 bg-gray-900 accent-yellow-400 disabled:opacity-60"
              />
              Obrigatório
            </label>
            <button
              type="submit"
              disabled={isCreating}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-70"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              {isCreating ? "Salvando..." : "Adicionar"}
            </button>
          </form>

          {error && (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400">
              {error}
            </p>
          )}

          {/* Lista de adicionais */}
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Cadastrados ({items.length})
            </p>
            {items.length === 0 ? (
              <p className="rounded-lg bg-gray-700/30 px-3 py-2 text-center text-xs font-medium text-gray-500">
                Nenhum adicional cadastrado para este produto.
              </p>
            ) : (
              <ul className="space-y-2">
                {items.map((addon) => {
                  const busy = busyId === addon.id;
                  return (
                    <li
                      key={addon.id}
                      className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2"
                    >
                      <span
                        className={`min-w-0 flex-1 truncate text-sm font-medium ${
                          addon.is_active
                            ? "text-gray-100"
                            : "text-gray-500 line-through"
                        }`}
                      >
                        {addon.name}
                      </span>
                      <span className="shrink-0 text-xs font-bold tabular-nums text-yellow-300">
                        + {formatBRL(addon.price)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleToggleRequired(addon)}
                        disabled={busy}
                        title={
                          addon.is_required
                            ? "Obrigatório — tornar opcional"
                            : "Opcional — tornar obrigatório"
                        }
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition disabled:opacity-50 ${
                          addon.is_required
                            ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                            : "border-gray-600/50 bg-gray-600/30 text-gray-400"
                        }`}
                      >
                        {addon.is_required ? "Obrigatório" : "Opcional"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleToggle(addon)}
                        disabled={busy}
                        title={addon.is_active ? "Pausar adicional" : "Ativar adicional"}
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition disabled:opacity-50 ${
                          addon.is_active
                            ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                            : "border-gray-600/50 bg-gray-600/30 text-gray-400"
                        }`}
                      >
                        {addon.is_active ? "Ativo" : "Pausado"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(addon)}
                        disabled={busy}
                        aria-label={`Excluir ${addon.name}`}
                        className="shrink-0 rounded-lg border border-red-500/30 px-2 py-1 text-xs font-semibold text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end border-t border-gray-800 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
