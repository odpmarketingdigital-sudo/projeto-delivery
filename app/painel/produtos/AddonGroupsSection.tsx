"use client";

import { useState, type FormEvent } from "react";
import type { MenuAddon, MenuAddonGroup, MenuProduct } from "@/lib/types";
import { sortByOrder } from "@/lib/menuOrder";

interface AddonGroupsSectionProps {
  establishmentId: string;
  /** Indica se o requisitante é super_admin (define se envia establishment_id). */
  isSuperAdmin: boolean;
  /** Produto dono dos grupos exibidos. */
  product: MenuProduct;
  /** Grupos de opções do estabelecimento (o componente filtra por produto). */
  addonGroups: MenuAddonGroup[];
  /** Adicionais do estabelecimento — usados apenas para contar os itens do grupo. */
  addons: MenuAddon[];
  /** Chamado após criar/editar/pausar/excluir para recarregar o cardápio. */
  onChanged: () => void;
}

/** Resumo textual da regra de seleção do grupo (ex: "1 a 3", "Até 5"). */
function ruleLabel(group: MenuAddonGroup): string {
  const max = Math.max(1, Math.floor(Number(group.max_selectors)) || 1);
  const rawMin = Math.max(0, Math.floor(Number(group.min_selectors)) || 0);
  const min = group.is_required ? Math.max(1, rawMin) : rawMin;
  if (max === 1) return "Escolha 1";
  if (min === 0) return `Até ${max}`;
  return min === max ? `Escolha ${min}` : `${min} a ${max}`;
}

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-gray-500 outline-none transition focus:border-amber-500 disabled:opacity-60";

/**
 * Gestão dos grupos de opções de um produto (estilo Menudino/iFood):
 * criar, editar (nome/descrição/obrigatoriedade/mín/máx), pausar e excluir.
 *
 * Consome /api/addon-groups (GET vem do cardápio; POST/PUT/DELETE aqui).
 * Os itens do grupo ficam em `public.addons` (`group_id`) — excluir um grupo
 * não apaga os itens, apenas os deixa "sem grupo".
 */
export function AddonGroupsSection({
  establishmentId,
  isSuperAdmin,
  product,
  addonGroups,
  addons,
  onChanged,
}: AddonGroupsSectionProps) {
  const groups = sortByOrder(
    addonGroups.filter((group) => group.product_id === product.id)
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isRequired, setIsRequired] = useState(true);
  const [minSelectors, setMinSelectors] = useState("1");
  const [maxSelectors, setMaxSelectors] = useState("1");
  const [isSaving, setIsSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setIsRequired(true);
    setMinSelectors("1");
    setMaxSelectors("1");
    setError(null);
  };

  const startEdit = (group: MenuAddonGroup) => {
    setEditingId(group.id);
    setName(group.name);
    setDescription(group.description ?? "");
    setIsRequired(group.is_required);
    setMinSelectors(String(group.min_selectors ?? 1));
    setMaxSelectors(String(group.max_selectors ?? 1));
    setError(null);
  };

  /** Cria um grupo (POST) ou salva as alterações de um grupo (PUT). */
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSaving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Informe o nome do grupo.");
      return;
    }
    const min = Math.floor(Number(minSelectors));
    const max = Math.floor(Number(maxSelectors));
    if (
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min < 0 ||
      max < 1 ||
      min > max
    ) {
      setError("Regra inválida: mínimo ≥ 0, máximo ≥ 1 e mínimo ≤ máximo.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: trimmed,
        description: description.trim(),
        is_required: isRequired,
        min_selectors: min,
        max_selectors: max,
      };
      if (editingId) {
        body.id = editingId;
      } else {
        body.product_id = product.id;
        if (isSuperAdmin) body.establishment_id = establishmentId;
      }
      const res = await fetch("/api/addon-groups", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao salvar o grupo.");
      resetForm();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar o grupo.");
    } finally {
      setIsSaving(false);
    }
  };

  /** Pausa/ativa um grupo (PUT com apenas { id, is_active }). */
  const handleToggle = async (group: MenuAddonGroup) => {
    if (busyId) return;
    setBusyId(group.id);
    setError(null);
    try {
      const res = await fetch("/api/addon-groups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: group.id, is_active: !group.is_active }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao atualizar o grupo.");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao atualizar o grupo.");
    } finally {
      setBusyId(null);
    }
  };

  /** Exclui um grupo (DELETE) — os itens continuam existindo, mas sem grupo. */
  const handleDelete = async (group: MenuAddonGroup) => {
    if (busyId) return;
    setBusyId(group.id);
    setError(null);
    try {
      const res = await fetch("/api/addon-groups", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: group.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao excluir o grupo.");
      if (editingId === group.id) resetForm();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao excluir o grupo.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3.5">
      <h3 className="text-sm font-bold text-slate-900">Grupos de opções</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Defina regras de escolha (ex.: “Tipo de carne” obrigatório, “Adicionais”
        opcional). Itens sem grupo aparecem juntos em “Adicionais”.
      </p>

      {groups.length === 0 ? (
        <p className="mt-2.5 rounded-lg bg-slate-100 px-3 py-2 text-center text-xs font-medium text-slate-500">
          Nenhum grupo criado para este produto.
        </p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {groups.map((group) => {
            const itemCount = addons.filter(
              (addon) => addon.group_id === group.id
            ).length;
            const busy = busyId === group.id;
            return (
              <li
                key={group.id}
                className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm font-semibold ${
                      group.is_active
                        ? "text-slate-900"
                        : "text-slate-500 line-through"
                    }`}
                  >
                    {group.name}
                  </p>
                  <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                    {group.is_required ? "Obrigatório" : "Opcional"} ·{" "}
                    {ruleLabel(group)} · {itemCount}{" "}
                    {itemCount === 1 ? "item" : "itens"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => startEdit(group)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                >
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => void handleToggle(group)}
                  disabled={busy}
                  title={group.is_active ? "Pausar grupo" : "Ativar grupo"}
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition disabled:opacity-50 ${
                    group.is_active
                      ? "border-emerald-200 bg-emerald-100 text-emerald-700"
                      : "border-slate-300 bg-slate-200 text-slate-600"
                  }`}
                >
                  {group.is_active ? "Ativo" : "Pausado"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(group)}
                  disabled={busy}
                  aria-label={`Excluir o grupo ${group.name}`}
                  className="shrink-0 rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                >
                  Excluir
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        onSubmit={handleSubmit}
        className="mt-3 space-y-2 rounded-xl border border-dashed border-slate-300 p-3"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {editingId ? "Editar grupo" : "Novo grupo"}
        </p>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nome do grupo (ex: Tipo de carne)"
          disabled={isSaving}
          className={inputClass}
        />
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Instrução ao cliente (opcional)"
          disabled={isSaving}
          className={inputClass}
        />
        <div className="flex items-end gap-2">
          <div className="w-20">
            <label
              htmlFor="addon-group-min"
              className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            >
              Mín.
            </label>
            <input
              id="addon-group-min"
              type="number"
              min={0}
              value={minSelectors}
              onChange={(event) => setMinSelectors(event.target.value)}
              disabled={isSaving}
              className={inputClass}
            />
          </div>
          <div className="w-20">
            <label
              htmlFor="addon-group-max"
              className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            >
              Máx.
            </label>
            <input
              id="addon-group-max"
              type="number"
              min={1}
              value={maxSelectors}
              onChange={(event) => setMaxSelectors(event.target.value)}
              disabled={isSaving}
              className={inputClass}
            />
          </div>
          <label className="flex flex-1 items-center gap-2 pb-2 text-xs font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={isRequired}
              onChange={(event) => setIsRequired(event.target.checked)}
              disabled={isSaving}
              className="h-4 w-4 accent-amber-500"
            />
            Obrigatório
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={isSaving}
            className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSaving
              ? "Salvando..."
              : editingId
                ? "Salvar alterações"
                : "Criar grupo"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              disabled={isSaving}
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
            >
              Cancelar
            </button>
          )}
        </div>
      </form>

      {error && (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
