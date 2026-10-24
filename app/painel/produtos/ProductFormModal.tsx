"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { Category, MenuProduct } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";

interface ProductFormModalProps {
  establishmentId: string;
  /** Indica se o requisitante é super_admin (define se envia establishment_id). */
  isSuperAdmin: boolean;
  categories: Category[];
  /** Produto em edição (null = criação). */
  editing: MenuProduct | null;
  onClose: () => void;
  onSubmitDone: () => void;
}

interface FormState {
  name: string;
  category_id: string;
  description: string;
  price: string;
  image_url: string;
  is_active: boolean;
  /** true = estoque limitado; false = estoque ilimitado. */
  track_stock: boolean;
  /** Quantidade em estoque (apenas quando `track_stock` é true). */
  stock_quantity: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  category_id: "",
  description: "",
  price: "",
  image_url: "",
  is_active: true,
  track_stock: false,
  stock_quantity: "0",
};

/**
 * Constrói o estado do formulário a partir do produto em edição.
 * Retorna um formulário limpo quando `editing` é nulo (modo criação).
 */
function toFormState(editing: MenuProduct | null): FormState {
  if (!editing) return EMPTY_FORM;
  return {
    name: editing.name,
    category_id: editing.category_id ?? "",
    description: editing.description,
    price: String(editing.price).replace(".", ","),
    image_url: editing.image_url,
    is_active: editing.is_active,
    track_stock: editing.track_stock === true,
    stock_quantity: String(editing.stock_quantity ?? 0),
  };
}

const inputClass =
  "w-full rounded-xl border border-gray-700 bg-gray-900/60 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60";

/** Bucket do Supabase Storage onde as imagens de produto são enviadas. */
const PRODUCTS_BUCKET = "products";

/** Tipos MIME de imagem aceitos no upload (PNG, JPG/JPEG e WebP). */
const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Extensões correspondentes, usadas para montar o nome do arquivo. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Tamanho máximo permitido por imagem (5 MB). */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Valor para o atributo `accept` do input de arquivo. */
const ACCEPT_ATTR = ACCEPTED_IMAGE_TYPES.join(",");

/**
 * Gera um caminho único e estável para o arquivo dentro do bucket.
 * Escopado por estabelecimento (`<establishmentId>/...`) — requisito das
 * policies de RLS do storage, que validam o 1º folder como `establishment_id`.
 */
function buildStoragePath(establishmentId: string, type: string): string {
  const ext = EXTENSION_BY_TYPE[type] ?? "png";
  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${establishmentId}/${unique}.${ext}`;
}

/**
 * Modal "Novo Produto" / "Editar Produto".
 *
 * Campos: Nome, Categoria, Descrição, Preço (R$), Imagem (upload para o bucket
 * `products` do Supabase Storage ou URL manual), Status (Disponível/Pausado) e
 * Controle de estoque (`track_stock` + `stock_quantity`).
 * Envia POST (criar) ou PUT (editar) para /api/products.
 */
export function ProductFormModal({
  establishmentId,
  isSuperAdmin,
  categories,
  editing,
  onClose,
  onSubmitDone,
}: ProductFormModalProps) {
  // Inicializa já com os dados do produto em edição. O modal é montado fresco
  // a cada abertura (em PainelProdutos é renderizado condicionalmente), e o
  // `editing` chega preenchido no 1º render — por isso o inicializador lazy é
  // obrigatório para não abrir em branco.
  const [form, setForm] = useState<FormState>(() => toFormState(editing));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Cliente Supabase (browser) para o upload no Storage. Memoizado para não
  // recriar a cada render — mesmo padrão de AuthContext/useEstablishment.
  const supabase = useMemo(() => createClient(), []);

  // Ressincroniza caso `editing` mude com o modal já montado (ex.: super admin
  // troca de produto sem desmontar). Ajuste durante o render, sem efeito.
  const [prevEditing, setPrevEditing] = useState(editing);
  if (editing !== prevEditing) {
    setPrevEditing(editing);
    setForm(toFormState(editing));
  }

  // Fecha com ESC e trava o scroll do body enquanto aberto.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting && !isUploading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, isSubmitting, isUploading]);

  const set = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  /** Converte "26,90" / "26.90" para número (aceita ambos). */
  const parsePrice = (raw: string): number => {
    const normalized = raw.trim().replace(/\./g, "").replace(",", ".");
    return Number(normalized);
  };

  /**
   * Faz o upload do arquivo selecionado para o bucket `products` do Supabase
   * Storage e grava a URL pública gerada em `form.image_url`.
   *
   * Valida tipo (PNG/JPG/JPEG/WebP) e tamanho (<= 5 MB) antes de enviar.
   * Em caso de erro, exibe a mensagem no campo de erro do formulário.
   */
  const handleImageUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Permite reselecionar o mesmo arquivo depois (o value é read-only).
    e.target.value = "";
    if (!file) return;

    if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
      setError("Formato não suportado. Envie uma imagem PNG, JPG/JPEG ou WebP.");
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setError("A imagem deve ter no máximo 5 MB.");
      return;
    }

    setError(null);
    setIsUploading(true);
    try {
      const path = buildStoragePath(establishmentId, file.type);
      const { error: uploadError } = await supabase.storage
        .from(PRODUCTS_BUCKET)
        .upload(path, file, { cacheControl: "3600", upsert: false });
      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from(PRODUCTS_BUCKET).getPublicUrl(path);
      set({ image_url: data.publicUrl });
    } catch (err) {
      setError(
        err instanceof Error
          ? `Falha ao enviar a imagem: ${err.message}`
          : "Falha ao enviar a imagem."
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isUploading) return;
    setError(null);

    const name = form.name.trim();
    if (!name) {
      setError("Informe o nome do produto.");
      return;
    }
    const price = parsePrice(form.price);
    if (!Number.isFinite(price) || price < 0) {
      setError("Informe um preço válido (ex: 26,90).");
      return;
    }

    // Estoque: quando o controle está desativado, o produto é ilimitado e a
    // quantidade é normalizada para 0.
    const trackStock = form.track_stock;
    let stockQuantity = 0;
    if (trackStock) {
      const parsedStock = Number(form.stock_quantity);
      if (
        form.stock_quantity.trim() === "" ||
        !Number.isInteger(parsedStock) ||
        parsedStock < 0
      ) {
        setError(
          "Informe uma quantidade em estoque válida (inteiro maior ou igual a zero)."
        );
        return;
      }
      stockQuantity = parsedStock;
    }

    const payload = {
      name,
      category_id: form.category_id || null,
      description: form.description.trim(),
      price,
      image_url: form.image_url.trim(),
      is_active: form.is_active,
      track_stock: trackStock,
      stock_quantity: stockQuantity,
    };

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/products", {
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
        throw new Error(data.error ?? "Falha ao salvar o produto.");
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
            {editing ? "Editar produto" : "Novo produto"}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {editing
              ? "Ajuste os dados e a disponibilidade do item."
              : "Adicione um item ao cardápio do estabelecimento."}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4"
        >
          <div>
            <label htmlFor="p-name" className="mb-1.5 block text-sm font-semibold text-gray-200">
              Nome
            </label>
            <input
              id="p-name"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Ex: X-Salada Artesanal"
              className={inputClass}
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="p-category" className="mb-1.5 block text-sm font-semibold text-gray-200">
              Categoria
            </label>
            <select
              id="p-category"
              value={form.category_id}
              onChange={(e) => set({ category_id: e.target.value })}
              className={inputClass}
            >
              <option value="">Sem categoria</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="p-desc" className="mb-1.5 block text-sm font-semibold text-gray-200">
              Descrição <span className="font-normal text-gray-500">(opcional)</span>
            </label>
            <textarea
              id="p-desc"
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              rows={3}
              maxLength={300}
              placeholder="Ex: Pão brioche, blend 160g, queijo, alface e tomate."
              className={`${inputClass} resize-none`}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="p-price" className="mb-1.5 block text-sm font-semibold text-gray-200">
                Preço (R$)
              </label>
              <input
                id="p-price"
                value={form.price}
                onChange={(e) => set({ price: e.target.value })}
                inputMode="decimal"
                placeholder="26,90"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="p-status" className="mb-1.5 block text-sm font-semibold text-gray-200">
                Status
              </label>
              <select
                id="p-status"
                value={form.is_active ? "disponivel" : "pausado"}
                onChange={(e) => set({ is_active: e.target.value === "disponivel" })}
                className={inputClass}
              >
                <option value="disponivel">Disponível</option>
                <option value="pausado">Pausado (esgotado)</option>
              </select>
            </div>
          </div>

          {/* Controle de estoque: desativado = ilimitado; ativado = quantidade. */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p
                  id="p-track-stock-label"
                  className="text-sm font-semibold text-gray-200"
                >
                  Controlar estoque?
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Desativado = estoque ilimitado. Ativado = o item fica
                  &quot;Esgotado&quot; na vitrine ao chegar a zero.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.track_stock}
                aria-labelledby="p-track-stock-label"
                onClick={() => set({ track_stock: !form.track_stock })}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-yellow-400/50 ${
                  form.track_stock ? "bg-yellow-400" : "bg-gray-700"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    form.track_stock ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            {form.track_stock && (
              <div className="mt-3">
                <label
                  htmlFor="p-stock"
                  className="mb-1.5 block text-sm font-semibold text-gray-200"
                >
                  Quantidade em estoque
                </label>
                <input
                  id="p-stock"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={form.stock_quantity}
                  onChange={(e) => set({ stock_quantity: e.target.value })}
                  placeholder="0"
                  className={inputClass}
                />
              </div>
            )}
          </div>

          <div>
            <label htmlFor="p-image-file" className="mb-1.5 block text-sm font-semibold text-gray-200">
              Imagem do produto
            </label>

            {/* Upload direto para o Supabase Storage (bucket `products`). */}
            <div className="flex items-center gap-3">
              <label
                htmlFor="p-image-file"
                className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-gray-700 bg-gray-900/60 px-3.5 py-2.5 text-sm font-semibold text-gray-200 transition hover:border-yellow-400/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 7.5L12 3m0 0L7.5 7.5M12 3v13.5"
                  />
                </svg>
                {isUploading ? "Enviando imagem..." : "Escolher arquivo"}
              </label>
              <input
                id="p-image-file"
                type="file"
                accept={ACCEPT_ATTR}
                onChange={handleImageUpload}
                disabled={isUploading || isSubmitting}
                className="hidden"
              />

              {isUploading ? (
                <span className="inline-flex items-center gap-2 text-xs text-gray-400">
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin text-yellow-400"
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
                  Enviando imagem...
                </span>
              ) : (
                <span className="text-xs text-gray-500">
                  PNG, JPG/JPEG ou WebP (até 5 MB)
                </span>
              )}
            </div>

            {/* Alternativa: colar uma URL manualmente. */}
            <div className="mt-3">
              <label htmlFor="p-image" className="mb-1.5 block text-xs font-medium text-gray-400">
                ...ou cole a URL da imagem
              </label>
              <input
                id="p-image"
                value={form.image_url}
                onChange={(e) => set({ image_url: e.target.value })}
                placeholder="/x-salada.webp ou https://..."
                className={inputClass}
              />
            </div>

            {form.image_url && (
              <div className="mt-2 flex items-center gap-3">
                <div className="relative h-12 w-12 overflow-hidden rounded-lg bg-gray-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.image_url}
                    alt="Pré-visualização"
                    className="h-full w-full object-cover"
                  />
                </div>
                <p className="text-xs text-gray-500">Pré-visualização da imagem.</p>
              </div>
            )}
          </div>

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-gray-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting || isUploading}
              className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting || isUploading}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting
                ? "Salvando..."
                : editing
                  ? "Salvar alterações"
                  : "Criar produto"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

