"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Category } from "@/lib/types";
import { sortByOrder } from "@/lib/menuOrder";

interface CategoriesModalProps {
  establishmentId: string;
  isSuperAdmin: boolean;
  categories: Category[];
  onClose: () => void;
  /** Chamado após criar/editar/excluir/reordenar para recarregar o cardápio. */
  onChanged: () => void;
}

/** Monta o corpo de criação/edição de categoria (estabelecimento p/ super admin). */
function buildBody(
  establishmentId: string,
  isSuperAdmin: boolean,
  extra: Record<string, unknown>
) {
  return isSuperAdmin ? { establishment_id: establishmentId, ...extra } : extra;
}

/**
 * Modal de Gestão de Categorias: criar, renomear, pausar (is_active), excluir e
 * reordenar (mover para cima/baixo) as categorias do estabelecimento.
 *
 * Consome /api/categories (GET é feito pela página; aqui POST/PUT/DELETE).
 */
export function CategoriesModal({
  establishmentId,
  isSuperAdmin,
  categories,
  onClose,
  onChanged,
}: CategoriesModalProps) {
  // Trabalhamos numa cópia local ordenada para reordenação otimista.
  const [items, setItems] = useState<Category[]>(() =>
    sortByOrder(categories)
  );
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Sincroniza se a lista externa mudar (ex.: recarga do cardápio). Ajuste
  // durante o render, evitando um efeito só para refletir a prop.
  const [prevCategories, setPrevCategories] = useState(categories);
  if (categories !== prevCategories) {
    setPrevCategories(categories);
    setItems(sortByOrder(categories));
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

  /** Cria uma nova categoria (POST). */
  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (isCreating) return;
    const name = newName.trim();
    if (!name) {
      setError("Informe o nome da categoria.");
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(establishmentId, isSuperAdmin, { name })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao criar a categoria.");
      setNewName("");
      onChanged();
    } catch (err) {
      setError(handleError(err, "Erro ao criar categoria."));
    } finally {
      setIsCreating(false);
    }
  };

  /** Salva o rename de uma categoria (PUT). */
  const handleRename = async (id: string) => {
    const name = editingName.trim();
    if (!name) {
      setError("O nome não pode ficar vazio.");
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao renomear.");
      setEditingId(null);
      setEditingName("");
      onChanged();
    } catch (err) {
      setError(handleError(err, "Erro ao renomear categoria."));
    } finally {
      setBusyId(null);
    }
  };

  /** Alterna o status ativo/pausado de uma categoria (PUT). */
  const handleToggle = async (cat: Category) => {
    setBusyId(cat.id);
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cat.id, is_active: !cat.is_active }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao atualizar status.");
      onChanged();
    } catch (err) {
      setError(handleError(err, "Erro ao atualizar status."));
    } finally {
      setBusyId(null);
    }
  };

  /** Exclui uma categoria (DELETE). Os produtos ficam "sem categoria". */
  const handleDelete = async (cat: Category) => {
    setBusyId(cat.id);
    setError(null);
    try {
      const res = await fetch(`/api/categories?id=${encodeURIComponent(cat.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao excluir.");
      onChanged();
    } catch (err) {
      setError(handleError(err, "Erro ao excluir categoria."));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Reordena movendo uma categoria para cima/baixo e persiste a nova sequência
   * inteira via PUT em lote (`{ order: [{id, position}, ...] }`).
   */
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;

    // Nova ordem (troca simples no array local).
    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

    // Atribui positions sequenciais (0..n) e atualiza otimisticamente.
    const withPositions = reordered.map((cat, i) => ({ ...cat, position: i }));
    setItems(withPositions);

    try {
      const res = await fetch("/api/categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order: withPositions.map((c) => ({ id: c.id, position: c.position })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao reordenar.");
      onChanged();
    } catch (err) {
      setError(handleError(err, "Erro ao reordenar categorias."));
      // Reverte para a ordem externa conhecida.
      setItems(sortByOrder(categories));
    }
  };


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-gray-800 bg-gray-900 shadow-xl">
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-bold text-white">Gerenciar categorias</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Crie, renomeie, reordene e pause as categorias do cardápio.
          </p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Criar nova categoria */}
          <form onSubmit={handleCreate} className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nova categoria (ex: Sobremesas)"
              className="flex-1 rounded-xl border border-gray-700 bg-gray-900/60 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60"
            />
            <button
              type="submit"
              disabled={isCreating}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isCreating ? "..." : "Adicionar"}
            </button>
          </form>

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400">
              {error}
            </p>
          )}

          {/* Lista de categorias (ordenadas) */}
          {items.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-500">
              Nenhuma categoria ainda. Crie a primeira acima.
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((cat, index) => {
                const isEditing = editingId === cat.id;
                const busy = busyId === cat.id;
                return (
                  <li
                    key={cat.id}
                    className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-900/50 px-3 py-2"
                  >
                    {/* Controles de ordem */}
                    <div className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                        aria-label={`Mover ${cat.name} para cima`}
                        className="text-gray-500 transition hover:text-gray-200 disabled:opacity-30"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, 1)}
                        disabled={index === items.length - 1}
                        aria-label={`Mover ${cat.name} para baixo`}
                        className="text-gray-500 transition hover:text-gray-200 disabled:opacity-30"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>

                    {/* Nome (texto ou input de edição) */}
                    {isEditing ? (
                      <input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename(cat.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        autoFocus
                        className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-100 outline-none focus:border-yellow-400/60"
                      />
                    ) : (
                      <span className="flex-1 truncate text-sm font-medium text-gray-100">
                        {cat.name}
                      </span>
                    )}
                    {/* Toggle ativo/pausado */}
                    <button
                      type="button"
                      onClick={() => handleToggle(cat)}
                      disabled={busy}
                      title={cat.is_active ? "Pausar categoria" : "Ativar categoria"}
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition disabled:opacity-50 ${
                        cat.is_active
                          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                          : "border-gray-600/50 bg-gray-600/30 text-gray-400"
                      }`}
                    >
                      {cat.is_active ? "Ativa" : "Pausada"}
                    </button>

                    {/* Editar/salvar */}
                    {isEditing ? (
                      <button
                        type="button"
                        onClick={() => handleRename(cat.id)}
                        disabled={busy}
                        className="shrink-0 rounded-lg bg-yellow-400 px-2.5 py-1 text-xs font-bold text-gray-950 transition hover:bg-yellow-300 disabled:opacity-50"
                      >
                        Salvar
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(cat.id);
                          setEditingName(cat.name);
                        }}
                        disabled={busy}
                        className="shrink-0 rounded-lg border border-gray-700 px-2.5 py-1 text-xs font-semibold text-gray-200 transition hover:bg-gray-800 disabled:opacity-50"
                      >
                        Editar
                      </button>
                    )}

                    {/* Excluir */}
                    <button
                      type="button"
                      onClick={() => handleDelete(cat)}
                      disabled={busy}
                      aria-label={`Excluir ${cat.name}`}
                      className="shrink-0 rounded-lg border border-red-500/30 px-2 py-1 text-xs font-semibold text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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


