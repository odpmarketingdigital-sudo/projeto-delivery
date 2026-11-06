"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import {
  formatCurrencyInput,
  formatCurrencyValue,
  parseCurrencyInput,
} from "@/lib/currency";
import type { ImportedMenu } from "@/lib/types";

interface ImportMenuModalProps {
  establishmentId: string;
  /** Indica se o requisitante é super_admin (define se envia establishment_id). */
  isSuperAdmin: boolean;
  onClose: () => void;
  /** Chamado após salvar com sucesso: recarrega o cardápio e fecha o modal. */
  onImported: () => void;
}

/** Produto em revisão (preço como string mascarada, ex.: "29,90"). */
interface ReviewProduct {
  key: string;
  name: string;
  description: string;
  price: string;
}

/** Categoria em revisão, com os produtos editáveis. */
interface ReviewCategory {
  key: string;
  name: string;
  products: ReviewProduct[];
}

/** Resultado do save em lote (contadores retornados pela API). */
interface ImportResult {
  categories: number;
  products: number;
}

type Step = "upload" | "review";

/** Tipos MIME aceitos no upload do cardápio. */
const ACCEPTED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;

/** Valor para o atributo `accept` do input de arquivo. */
const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");

/** Limite de tamanho do arquivo (espelha o limite da rota de API). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-gray-500 outline-none transition focus:border-amber-500";

/** Verifica se o arquivo é um PDF/imagem aceito (também pela extensão). */
function isAcceptedFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (
    type === "application/pdf" ||
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/jpg"
  ) {
    return true;
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  return (
    extension === "pdf" ||
    extension === "png" ||
    extension === "jpg" ||
    extension === "jpeg"
  );
}

/** Formata bytes em KB/MB para exibir junto ao nome do arquivo. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/**
 * Converte o cardápio devolvido pela IA em estado editável do modal.
 * Cria chaves estáveis para inputs controlados (não usamos o índice).
 */
function toReviewCategories(
  menu: ImportedMenu | undefined,
  makeKey: (prefix: string) => string,
): ReviewCategory[] {
  if (!menu || !Array.isArray(menu.categories)) return [];

  return menu.categories.map((category) => ({
    key: makeKey("category"),
    name: category.name ?? "",
    products: (category.products ?? []).map((product) => ({
      key: makeKey("product"),
      name: product.name ?? "",
      description: product.description ?? "",
      price: formatCurrencyValue(Number(product.price) || 0),
    })),
  }));
}

/**
 * Modal "Importar Cardápio com IA".
 *
 * Fluxo em duas etapas: (1) upload de PDF/imagem do cardápio atual, analisado
 * pelo Gemini via `POST /api/ai/import-menu`; (2) revisão editável de nomes,
 * descrições e preços, gravando tudo em lote em `POST /api/ai/import-menu/save`.
 */
export function ImportMenuModal({
  establishmentId,
  isSuperAdmin,
  onClose,
  onImported,
}: ImportMenuModalProps) {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [categories, setCategories] = useState<ReviewCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState<ImportResult | null>(null);

  /** Contador de chaves estáveis das linhas em revisão. */
  const keyCounter = useRef(0);
  const isBusy = isAnalyzing || isSaving;

  const makeKey = (prefix: string) => {
    keyCounter.current += 1;
    return `${prefix}-${keyCounter.current}`;
  };

  const totalProducts = useMemo(
    () =>
      categories.reduce(
        (total, category) => total + category.products.length,
        0,
      ),
    [categories],
  );

  // Trava o scroll do body e fecha no ESC / clique no backdrop (padrão dos
  // demais modais do painel). Durante o processamento o fechamento é bloqueado.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isBusy) {
        if (saved) onImported();
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, onImported, isBusy, saved]);

  const requestClose = () => {
    if (isBusy) return;
    if (saved) {
      onImported();
      return;
    }
    onClose();
  };

  const stopPropagation = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    // Limpa o input para permitir selecionar o mesmo arquivo após um erro.
    event.target.value = "";

    setFileError(null);
    setError(null);

    if (!selected) {
      setFile(null);
      return;
    }
    if (!isAcceptedFile(selected)) {
      setFile(null);
      setFileError("Formato não suportado. Envie um PDF, PNG ou JPG.");
      return;
    }
    if (selected.size === 0) {
      setFile(null);
      setFileError("O arquivo selecionado está vazio.");
      return;
    }
    if (selected.size > MAX_FILE_SIZE) {
      setFile(null);
      setFileError(
        "O arquivo é muito grande. Envie um PDF ou imagem de até 10 MB.",
      );
      return;
    }

    setFile(selected);
  };

  const handleAnalyze = async () => {
    if (!file || isBusy) return;

    setIsAnalyzing(true);
    setError(null);

    try {
      const body = new FormData();
      body.append("file", file);
      if (isSuperAdmin) body.append("establishment_id", establishmentId);

      const res = await fetch("/api/ai/import-menu", { method: "POST", body });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao analisar o cardápio.");
      }

      const review = toReviewCategories(
        (data as { menu?: ImportedMenu }).menu,
        makeKey,
      );
      if (
        review.length === 0 ||
        review.every((category) => category.products.length === 0)
      ) {
        throw new Error(
          "A IA não encontrou produtos legíveis no arquivo. Tente outra foto ou PDF.",
        );
      }

      setCategories(review);
      setStep("review");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erro inesperado ao analisar o cardápio.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const updateCategoryName = (key: string, name: string) => {
    setCategories((prev) =>
      prev.map((category) =>
        category.key === key ? { ...category, name } : category,
      ),
    );
  };

  const updateProduct = (
    categoryKey: string,
    productKey: string,
    patch: Partial<Pick<ReviewProduct, "name" | "description" | "price">>,
  ) => {
    setCategories((prev) =>
      prev.map((category) => {
        if (category.key !== categoryKey) return category;
        return {
          ...category,
          products: category.products.map((product) =>
            product.key === productKey ? { ...product, ...patch } : product,
          ),
        };
      }),
    );
  };

  const removeProduct = (categoryKey: string, productKey: string) => {
    setCategories((prev) =>
      prev.map((category) =>
        category.key === categoryKey
          ? {
              ...category,
              products: category.products.filter(
                (product) => product.key !== productKey,
              ),
            }
          : category,
      ),
    );
  };

  const removeCategory = (key: string) => {
    setCategories((prev) => prev.filter((category) => category.key !== key));
  };

  const handleSave = async () => {
    if (isBusy) return;
    setError(null);

    if (categories.length === 0) {
      setError("Nenhuma categoria para salvar.");
      return;
    }

    // Validação antes do envio: evita gravar nomes vazios ou preços inválidos.
    for (const category of categories) {
      if (!category.name.trim()) {
        setError("Todas as categorias precisam de um nome.");
        return;
      }
      for (const product of category.products) {
        if (!product.name.trim()) {
          setError("Todos os produtos precisam de um nome.");
          return;
        }
        const price = parseCurrencyInput(product.price);
        if (!Number.isFinite(price) || price < 0) {
          setError(`Informe um preço válido para "${product.name}".`);
          return;
        }
      }
    }

    const payload = {
      categories: categories
        .filter((category) => category.products.length > 0)
        .map((category) => ({
          name: category.name.trim(),
          products: category.products.map((product) => ({
            name: product.name.trim(),
            description: product.description.trim(),
            price: parseCurrencyInput(product.price),
          })),
        })),
    };

    if (payload.categories.length === 0) {
      setError("Adicione pelo menos um produto para salvar.");
      return;
    }

    setIsSaving(true);

    try {
      const body = isSuperAdmin
        ? { establishment_id: establishmentId, ...payload }
        : payload;

      const res = await fetch("/api/ai/import-menu/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao salvar os produtos importados.");
      }

      const created = (data as { created?: ImportResult }).created;
      setSaved({
        categories:
          created?.categories ??
          payload.categories.filter((category) => category.products.length > 0)
            .length,
        products:
          created?.products ??
          payload.categories.reduce(
            (total, category) => total + category.products.length,
            0,
          ),
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erro inesperado ao salvar o cardápio.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onClick={requestClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-menu-title"
        onClick={stopPropagation}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
              >
                <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </span>
            <div>
              <h2
                id="import-menu-title"
                className="text-lg font-bold text-slate-900"
              >
                Importar cardápio com IA
              </h2>
              <p className="text-sm text-slate-500">
                {saved
                  ? "Importação concluída"
                  : step === "upload"
                    ? "Envie o PDF ou uma foto do cardápio atual"
                    : "Revise os itens antes de salvar"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={isBusy}
            aria-label="Fechar"
            className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-5 w-5"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {saved ? (
            <div className="px-2 py-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-7 w-7"
                >
                  <path d="m5 13 4 4L19 7" />
                </svg>
              </div>
              <h3 className="mt-4 text-lg font-bold text-slate-900">
                Produtos importados!
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                {saved.categories} categoria(s) e {saved.products} produto(s)
                cadastrados no cardápio.
              </p>
              <button
                type="button"
                onClick={onImported}
                className="mt-6 inline-flex items-center justify-center rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600"
              >
                Concluir
              </button>
            </div>
          ) : step === "upload" ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                A IA identifica as categorias e os produtos com preço a partir
                do arquivo. Você revisa e ajusta tudo antes de salvar no
                cardápio.
              </div>

              <label
                htmlFor="import-menu-file"
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center transition hover:border-amber-400 hover:bg-amber-50"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-amber-600 shadow-sm">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-6 w-6"
                  >
                    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
                    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                  </svg>
                </span>
                <span className="max-w-full truncate text-sm font-semibold text-slate-800">
                  {file ? file.name : "Escolher arquivo do cardápio"}
                </span>
                <span className="text-xs text-slate-500">
                  {file
                    ? formatFileSize(file.size)
                    : "PDF, PNG ou JPG — até 10 MB"}
                </span>
                {file && (
                  <span className="text-xs font-semibold text-amber-700">
                    Clique para trocar o arquivo
                  </span>
                )}
              </label>
              <input
                id="import-menu-file"
                type="file"
                accept={ACCEPT_ATTR}
                onChange={handleFileChange}
                disabled={isBusy}
                className="hidden"
              />

              {(fileError || error) && (
                <p
                  role="alert"
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                >
                  {fileError ?? error}
                </p>
              )}

              {isAnalyzing && (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center">
                  <span
                    aria-hidden="true"
                    className="h-6 w-6 animate-spin rounded-full border-2 border-amber-500 border-t-transparent"
                  />
                  <p className="text-sm font-semibold text-slate-800">
                    A IA está analisando o cardápio...
                  </p>
                  <p className="text-xs text-slate-500">
                    Isso pode levar até 1 minuto. Não feche esta janela.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-semibold text-slate-700">
                  {categories.length} categoria(s) • {totalProducts} produto(s)
                </p>
                <p className="text-xs text-slate-500">
                  Ajuste nomes, preços e descrições antes de salvar.
                </p>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                >
                  {error}
                </p>
              )}

              <div className="space-y-4">
                {categories.map((category) => (
                  <div
                    key={category.key}
                    className="rounded-2xl border border-slate-200 bg-white p-4"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <label
                          htmlFor={`category-${category.key}`}
                          className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Categoria
                        </label>
                        <input
                          id={`category-${category.key}`}
                          type="text"
                          value={category.name}
                          maxLength={120}
                          onChange={(event) =>
                            updateCategoryName(category.key, event.target.value)
                          }
                          disabled={isBusy}
                          className={inputClass}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeCategory(category.key)}
                        disabled={isBusy}
                        aria-label={`Remover categoria ${category.name}`}
                        className="mt-5 shrink-0 rounded-lg border border-red-200 p-2 text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                        >
                          <path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" />
                        </svg>
                      </button>
                    </div>

                    <ul className="mt-3 space-y-3">
                      {category.products.map((product) => (
                        <li
                          key={product.key}
                          className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                        >
                          <div className="flex items-start gap-2">
                            <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-12">
                              <div className="sm:col-span-7">
                                <label
                                  htmlFor={`product-name-${product.key}`}
                                  className="sr-only"
                                >
                                  Nome do produto
                                </label>
                                <input
                                  id={`product-name-${product.key}`}
                                  type="text"
                                  value={product.name}
                                  maxLength={120}
                                  placeholder="Nome do produto"
                                  onChange={(event) =>
                                    updateProduct(category.key, product.key, {
                                      name: event.target.value,
                                    })
                                  }
                                  disabled={isBusy}
                                  className={inputClass}
                                />
                              </div>
                              <div className="sm:col-span-5">
                                <label
                                  htmlFor={`product-price-${product.key}`}
                                  className="sr-only"
                                >
                                  Preço
                                </label>
                                <div className="relative">
                                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-xs font-semibold text-slate-400">
                                    R$
                                  </span>
                                  <input
                                    id={`product-price-${product.key}`}
                                    type="text"
                                    inputMode="decimal"
                                    value={product.price}
                                    placeholder="0,00"
                                    onChange={(event) =>
                                      updateProduct(category.key, product.key, {
                                        price: formatCurrencyInput(
                                          event.target.value,
                                        ),
                                      })
                                    }
                                    disabled={isBusy}
                                    className={`${inputClass} pl-9 text-right tabular-nums`}
                                  />
                                </div>
                              </div>
                              <div className="sm:col-span-12">
                                <label
                                  htmlFor={`product-description-${product.key}`}
                                  className="sr-only"
                                >
                                  Descrição
                                </label>
                                <input
                                  id={`product-description-${product.key}`}
                                  type="text"
                                  value={product.description}
                                  maxLength={500}
                                  placeholder="Descrição (opcional)"
                                  onChange={(event) =>
                                    updateProduct(category.key, product.key, {
                                      description: event.target.value,
                                    })
                                  }
                                  disabled={isBusy}
                                  className={inputClass}
                                />
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                removeProduct(category.key, product.key)
                              }
                              disabled={isBusy}
                              aria-label={`Remover produto ${product.name}`}
                              className="shrink-0 rounded-lg border border-red-200 p-2 text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-4 w-4"
                              >
                                <path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" />
                              </svg>
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>

                    {category.products.length === 0 && (
                      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        Nenhum produto nesta categoria — ela não será salva.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {!saved && step === "upload" && (
          <div className="flex flex-col-reverse gap-3 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={requestClose}
              disabled={isAnalyzing}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={!file || isBusy}
              className="rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isAnalyzing ? "Analisando..." : "Analisar com IA"}
            </button>
          </div>
        )}

        {!saved && step === "review" && (
          <div className="flex flex-col-reverse gap-3 border-t border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("upload");
              }}
              disabled={isBusy}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Voltar
            </button>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={requestClose}
                disabled={isBusy}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isBusy || totalProducts === 0}
                className="rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? "Salvando..." : "Salvar produtos"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


