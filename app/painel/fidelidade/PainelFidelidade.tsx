"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useEstablishment } from "@/app/painel/produtos/useEstablishment";
import { formatPhoneInput } from "@/lib/billing";
import { formatCouponBRL } from "@/lib/coupons";
import { STORE_TIME_ZONE } from "@/lib/openingHours";
import {
  DEFAULT_LOYALTY_PROGRAM,
  LOYALTY_MAX_ORDERS_PER_REWARD,
  LOYALTY_MAX_POINTS_PER_REAL,
  LOYALTY_MAX_POINTS_PER_REWARD,
  LOYALTY_MAX_REWARD_PRODUCT_QUANTITY,
  LOYALTY_MAX_REWARD_VALUE,
  LOYALTY_REWARD_MODES,
  LOYALTY_REWARD_MODE_HINTS,
  LOYALTY_REWARD_MODE_LABELS,
  LOYALTY_REWARD_TYPES,
  LOYALTY_REWARD_TYPE_LABELS,
  loyaltyNextRewardRemaining,
  loyaltyOrdersGoalLabel,
  loyaltyOrdersRemaining,
  loyaltyPointsLabel,
  loyaltyProgramRuleLabel,
  loyaltyRewardLabel,
  normalizeLoyaltyPhone,
  type LoyaltyProgram,
  type LoyaltyRewardMode,
  type LoyaltyRewardType,
} from "@/lib/loyalty";
import type {
  LoyaltyAccount,
  LoyaltyTransaction,
} from "@/lib/loyalty-server";
import type { MenuData, MenuProduct } from "@/lib/types";

/** Data/hora no fuso da loja. */
function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: STORE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Rótulo do movimento do extrato. */
function transactionKindLabel(kind: string): string {
  switch (kind) {
    case "earn":
      return "Pedido finalizado";
    case "redeem":
      return "Resgate";
    case "refund":
      return "Estorno";
    case "adjust":
      return "Ajuste manual";
    default:
      return kind || "Movimento";
  }
}

/** Telefone legível — `null` quando vazio. */
function formatPhone(phone: string): string {
  const digits = normalizeLoyaltyPhone(phone);
  return digits ? formatPhoneInput(digits) : "—";
}

/** Formulário do programa (inputs controlados como texto). */
interface ProgramForm {
  enabled: boolean;
  rewardMode: LoyaltyRewardMode;
  pointsPerReal: string;
  pointsPerReward: string;
  rewardType: LoyaltyRewardType;
  rewardValue: string;
  minOrderValue: string;
  ordersPerReward: string;
  /** Produtos elegíveis (o cliente escolhe entre eles no resgate). */
  rewardProductIds: string[];
  /** Quantos itens grátis o cliente ganha ao usar 1 prêmio. */
  rewardProductQuantity: string;
}

function formFromProgram(program: LoyaltyProgram): ProgramForm {
  return {
    enabled: program.enabled,
    rewardMode: program.reward_mode,
    pointsPerReal: String(program.points_per_real),
    pointsPerReward: String(program.points_per_reward),
    rewardType: program.reward_type,
    rewardValue: String(program.reward_value),
    minOrderValue: String(program.min_order_value),
    ordersPerReward: String(program.orders_per_reward),
    rewardProductIds: program.reward_product_ids,
    rewardProductQuantity: String(program.reward_product_quantity),
  };
}

/**
 * Gestão do programa de fidelidade do estabelecimento.
 *
 * - Configura como o cliente acumula: pontos por real gasto (prêmio em R$, %,
 *   frete grátis ou produto) ou quantidade de pedidos finalizados (prêmio =
 *   produto grátis do cardápio).
 * - Lista os participantes com saldo/pedidos e permite consultar o extrato.
 * - Ajuste manual (crédito/débito) para casos de suporte.
 *
 * Todas as escritas passam pelas rotas `/api/loyalty*`; o checkout e
 * `POST /api/orders` continuam sendo a fonte da verdade dos pontos.
 */
export function PainelFidelidade() {
  const {
    establishments,
    selectedId,
    isSuperAdmin,
    isLoading: isLoadingEst,
    error: estError,
    select,
  } = useEstablishment();

  const [program, setProgram] = useState<LoyaltyProgram>({
    ...DEFAULT_LOYALTY_PROGRAM,
  });
  const [form, setForm] = useState<ProgramForm>(
    formFromProgram(DEFAULT_LOYALTY_PROGRAM)
  );
  const [participants, setParticipants] = useState<LoyaltyAccount[]>([]);
  // Cardápio da loja — fonte dos produtos entregues como prêmio (modo por pedidos).
  const [products, setProducts] = useState<MenuProduct[]>([]);
  // Busca dentro da lista de produtos elegíveis (cardápios grandes).
  const [productSearch, setProductSearch] = useState("");
  /** O formulário precisa do cardápio para escolher o produto do prêmio. */
  const needsRewardProduct =
    form.rewardMode === "orders" || form.rewardType === "free_product";
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Extrato do participante selecionado.
  const [historyPhone, setHistoryPhone] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Ajuste manual de pontos.
  const [adjustPhone, setAdjustPhone] = useState("");
  const [adjustName, setAdjustName] = useState("");
  const [adjustMode, setAdjustMode] = useState<"add" | "remove">("add");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustDescription, setAdjustDescription] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [isAdjusting, setIsAdjusting] = useState(false);

  // Descarta respostas fora de ordem quando o estabelecimento muda rápido.
  const requestSeq = useRef(0);

  const fetchProgram = useCallback(async () => {
    if (!selectedId) return;
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/loyalty?establishment_id=${encodeURIComponent(selectedId)}`,
        { cache: "no-store" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        program?: LoyaltyProgram;
        participants?: LoyaltyAccount[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao carregar a fidelidade.");
      }
      if (seq !== requestSeq.current) return;
      const nextProgram = data.program ?? { ...DEFAULT_LOYALTY_PROGRAM };
      setProgram(nextProgram);
      setForm(formFromProgram(nextProgram));
      setParticipants(data.participants ?? []);
      // A lista pode vir vazia quando a migração ainda não rodou.
      setError(data.error ?? null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setParticipants([]);
      setError(
        err instanceof Error ? err.message : "Erro inesperado ao carregar."
      );
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [selectedId]);

  /** Carrega o cardápio (GET /api/products) para escolher o produto do prêmio. */
  const fetchProducts = useCallback(async () => {
    if (!selectedId) return;
    try {
      const res = await fetch(
        `/api/products?establishment_id=${encodeURIComponent(selectedId)}`,
        { cache: "no-store" }
      );
      const data = (await res.json().catch(() => ({}))) as
        | (Partial<MenuData> & { error?: string })
        | { error?: string };
      if (!res.ok) {
        // Cardápio indisponível não bloqueia a configuração por pontos.
        setProducts([]);
        return;
      }
      const menu = data as Partial<MenuData>;
      setProducts(menu.products ?? []);
    } catch {
      setProducts([]);
    }
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    (async () => {
      // Só busca o cardápio quando o prêmio é de fato um produto do cardápio.
      if (!active || !selectedId || !needsRewardProduct) return;
      await fetchProducts();
    })();
    return () => {
      active = false;
    };
  }, [fetchProducts, needsRewardProduct, selectedId]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await fetchProgram();
    })();
    return () => {
      active = false;
    };
  }, [fetchProgram]);

  /** Salva a configuração (PUT /api/loyalty). */
  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedId) return;
    setIsSaving(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await fetch("/api/loyalty", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          enabled: form.enabled,
          reward_mode: form.rewardMode,
          points_per_real: Number(form.pointsPerReal),
          points_per_reward: Number(form.pointsPerReward),
          reward_type:
            form.rewardMode === "orders" ? "free_product" : form.rewardType,
          reward_value:
            form.rewardMode === "orders" ||
            form.rewardType === "free_shipping" ||
            form.rewardType === "free_product"
              ? 0
              : Number(form.rewardValue),
          min_order_value: Number(form.minOrderValue || 0),
          orders_per_reward: Number(form.ordersPerReward || 0) || undefined,
          // Lista completa + primeiro item no campo legado (`reward_product_id`).
          reward_product_ids: form.rewardProductIds,
          reward_product_id: form.rewardProductIds[0] ?? null,
          reward_product_quantity: Math.max(
            1,
            Math.trunc(Number(form.rewardProductQuantity)) || 1
          ),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        program?: LoyaltyProgram;
        error?: string;
      };
      if (!res.ok || !data.program) {
        throw new Error(data.error ?? "Falha ao salvar o programa.");
      }
      setProgram(data.program);
      setForm(formFromProgram(data.program));
      setFeedback("Programa de fidelidade salvo com sucesso.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsSaving(false);
    }
  };

  /** Carrega o extrato de um participante (GET /api/loyalty/transactions). */
  const loadHistory = useCallback(
    async (phone: string) => {
      if (!selectedId) return;
      setHistoryPhone(phone);
      setIsLoadingHistory(true);
      setHistoryError(null);
      try {
        const res = await fetch(
          `/api/loyalty/transactions?establishment_id=${encodeURIComponent(
            selectedId
          )}&phone=${encodeURIComponent(phone)}`,
          { cache: "no-store" }
        );
        const data = (await res.json().catch(() => ({}))) as {
          transactions?: LoyaltyTransaction[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error ?? "Falha ao carregar o extrato.");
        }
        setTransactions(data.transactions ?? []);
      } catch (err) {
        setTransactions([]);
        setHistoryError(
          err instanceof Error ? err.message : "Erro inesperado no extrato."
        );
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [selectedId]
  );

  /** Ajuste manual de pontos (POST /api/loyalty/adjust). */
  const handleAdjust = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedId) return;
    setAdjustError(null);
    setFeedback(null);

    const amount = Math.trunc(Number(adjustAmount));
    if (!Number.isFinite(amount) || amount <= 0) {
      setAdjustError("Informe uma quantidade de pontos maior que zero.");
      return;
    }
    if (normalizeLoyaltyPhone(adjustPhone).length < 10) {
      setAdjustError("Informe o telefone do cliente com DDD.");
      return;
    }

    setIsAdjusting(true);
    try {
      const delta = adjustMode === "add" ? amount : -amount;
      const res = await fetch("/api/loyalty/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          establishment_id: selectedId,
          phone: adjustPhone,
          customer_name: adjustName || undefined,
          delta,
          description: adjustDescription || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        account?: LoyaltyAccount | null;
        balance?: number;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao ajustar os pontos.");
      }

      const newBalance = data.balance ?? data.account?.balance ?? 0;
      setFeedback(
        `${delta > 0 ? "Crédito" : "Débito"} de ${Math.abs(
          delta
        )} pontos aplicado. Saldo atual: ${newBalance}.`
      );
      setAdjustAmount("");
      setAdjustDescription("");
      await fetchProgram();
      if (historyPhone) await loadHistory(historyPhone);
    } catch (err) {
      setAdjustError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsAdjusting(false);
    }
  };

  /** Abre o formulário de ajuste já preenchido com o participante. */
  const startAdjustFor = (account: LoyaltyAccount) => {
    setAdjustPhone(formatPhoneInput(account.phone));
    setAdjustName(account.name ?? "");
    setAdjustMode("add");
    setAdjustAmount("");
    setAdjustDescription("");
    setAdjustError(null);
    setFeedback(null);
  };

  const summary = useMemo(() => {
    const balance = participants.reduce((sum, item) => sum + item.balance, 0);
    const redeemed = participants.reduce(
      (sum, item) => sum + item.rewards_redeemed,
      0
    );
    const freeRewards = participants.reduce(
      (sum, item) => sum + item.free_rewards_available,
      0
    );
    return { balance, redeemed, freeRewards };
  }, [participants]);

  /** Prévia do prêmio configurado (mostrada ao lado do formulário). */
  const nextRewardPreview = useMemo(() => {
    const previewProgram: LoyaltyProgram = {
      enabled: form.enabled,
      reward_mode: form.rewardMode,
      points_per_real: Number(form.pointsPerReal) || 1,
      points_per_reward: Math.trunc(Number(form.pointsPerReward)) || 1,
      reward_type:
        form.rewardMode === "orders" ? "free_product" : form.rewardType,
      reward_value: Number(form.rewardValue) || 0,
      min_order_value: Number(form.minOrderValue) || 0,
      orders_per_reward: Math.trunc(Number(form.ordersPerReward)) || 1,
      reward_product_id: form.rewardProductIds[0] ?? null,
      reward_product_name:
        form.rewardProductIds.length === 1
          ? (products.find((product) => product.id === form.rewardProductIds[0])
              ?.name ?? null)
          : null,
      reward_product_ids: form.rewardProductIds,
      reward_product_quantity: Math.max(
        1,
        Math.trunc(Number(form.rewardProductQuantity)) || 1
      ),
    };
    const isOrdersMode = previewProgram.reward_mode === "orders";
    return {
      isOrdersMode,
      ruleLabel: loyaltyProgramRuleLabel(previewProgram),
      rewardLabel: loyaltyRewardLabel(previewProgram),
      goalLabel: isOrdersMode
        ? loyaltyOrdersGoalLabel(previewProgram)
        : loyaltyPointsLabel(previewProgram.points_per_reward),
      firstReward: isOrdersMode
        ? `${loyaltyOrdersRemaining(previewProgram, 0, 0)} pedidos`
        : loyaltyPointsLabel(loyaltyNextRewardRemaining(previewProgram, 0)),
      missingProduct:
        needsRewardProduct && form.rewardProductIds.length === 0,
      productCount: form.rewardProductIds.length,
      productQuantity: previewProgram.reward_product_quantity,
    };
  }, [form, needsRewardProduct, products]);

  /** Cardápio ativo — só ele pode virar prêmio (mesma regra da API). */
  const activeProducts = useMemo(
    () => products.filter((product) => product.is_active),
    [products]
  );

  /** Lista filtrada pela busca do lojista (nome, sem acentos/caixa). */
  const filteredProducts = useMemo(() => {
    const term = productSearch
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
    if (!term) return activeProducts;
    return activeProducts.filter((product) =>
      product.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .includes(term)
    );
  }, [activeProducts, productSearch]);

  /** Marca/desmarca um produto como elegível ao prêmio. */
  const toggleRewardProduct = (productId: string) => {
    setForm((prev) => ({
      ...prev,
      rewardProductIds: prev.rewardProductIds.includes(productId)
        ? prev.rewardProductIds.filter((id) => id !== productId)
        : [...prev.rewardProductIds, productId],
    }));
    setFeedback(null);
    setError(null);
  };

  return (
    <div className="flex flex-1 flex-col">
      <AdminHeader establishmentId={selectedId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Programa de fidelidade
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              O cliente acumula pontos a cada pedido finalizado e troca por
              desconto ou frete grátis. Os pontos são creditados pelo servidor
              quando o pedido é marcado como finalizado.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {isSuperAdmin && (
              <div>
                <label
                  htmlFor="fidelidade-estabelecimento"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Estabelecimento
                </label>
                <select
                  id="fidelidade-estabelecimento"
                  value={selectedId ?? ""}
                  onChange={(e) => select(e.target.value)}
                  disabled={isLoadingEst || establishments.length === 0}
                  className="min-w-56 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500 disabled:opacity-60"
                >
                  {establishments.map((est) => (
                    <option key={est.id} value={est.id}>
                      {est.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              type="button"
              onClick={() => void fetchProgram()}
              disabled={!selectedId || isLoading}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? "Atualizando…" : "Atualizar"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Situação
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
              {program.enabled ? "Ativo" : "Desligado"}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Participantes
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
              {participants.length}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {program.reward_mode === "orders"
                ? "Prêmios disponíveis"
                : "Pontos em circulação"}
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-amber-600">
              {program.reward_mode === "orders"
                ? summary.freeRewards
                : summary.balance}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Prêmios resgatados
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
              {summary.redeemed}
            </p>
          </div>
        </div>

        {feedback && (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {feedback}
          </p>
        )}
        {(error || estError) && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error ?? estError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <form
            onSubmit={handleSave}
            className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Configuração do programa
                </h2>
                <p className="text-sm text-slate-600">
                  Ajuste as regras e salve — o checkout passa a mostrar os
                  pontos na hora.
                </p>
              </div>

              <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-800">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-slate-300 text-amber-500 focus:ring-amber-400"
                />
                Programa ativo
              </label>
            </div>

            <div>
              <label
                htmlFor="fidelidade-modo-acumulo"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Como o cliente acumula
              </label>
              <select
                id="fidelidade-modo-acumulo"
                value={form.rewardMode}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    rewardMode: e.target.value as LoyaltyRewardMode,
                  }))
                }
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
              >
                {LOYALTY_REWARD_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {LOYALTY_REWARD_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {LOYALTY_REWARD_MODE_HINTS[form.rewardMode]}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {form.rewardMode === "points" ? (
                <>
              <div>
                <label
                  htmlFor="fidelidade-pontos-por-real"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Pontos por R$ 1,00 gasto
                </label>
                <input
                  id="fidelidade-pontos-por-real"
                  type="number"
                  min={1}
                  max={LOYALTY_MAX_POINTS_PER_REAL}
                  step={1}
                  required
                  value={form.pointsPerReal}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      pointsPerReal: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Sobre o subtotal dos itens (sem frete, já com descontos).
                </p>
              </div>

              <div>
                <label
                  htmlFor="fidelidade-pontos-por-premio"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Pontos necessários por prêmio
                </label>
                <input
                  id="fidelidade-pontos-por-premio"
                  type="number"
                  min={1}
                  max={LOYALTY_MAX_POINTS_PER_REWARD}
                  step={1}
                  required
                  value={form.pointsPerReward}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      pointsPerReward: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                />
              </div>
                </>
              ) : (
                <>
                  <div className="sm:col-span-2">
                    <label
                      htmlFor="fidelidade-pedidos-por-premio"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Pedidos finalizados por prêmio
                    </label>
                    <input
                      id="fidelidade-pedidos-por-premio"
                      type="number"
                      min={1}
                      max={LOYALTY_MAX_ORDERS_PER_REWARD}
                      step={1}
                      required
                      value={form.ordersPerReward}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          ordersPerReward: e.target.value,
                        }))
                      }
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Cada pedido finalizado conta 1. Pedidos cancelados são
                      descontados do ciclo.
                    </p>
                  </div>
                </>
              )}

              {form.rewardMode === "points" ? (
              <div>
                <label
                  htmlFor="fidelidade-tipo-premio"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Tipo de prêmio
                </label>
                <select
                  id="fidelidade-tipo-premio"
                  value={form.rewardType}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      rewardType: e.target.value as LoyaltyRewardType,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                >
                  {LOYALTY_REWARD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {LOYALTY_REWARD_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </div>
              ) : (
                <div className="sm:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Tipo de prêmio
                  </p>
                  <p className="mt-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                    Produto(s) grátis do cardápio a cada ciclo concluído — sem
                    desconto em R$, cada item entra no pedido por R$ 0,00. O
                    cliente escolhe entre os produtos habilitados abaixo.
                  </p>
                </div>
              )}

              {needsRewardProduct && (
                <div className="sm:col-span-2">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Produtos do prêmio
                  </span>
                  <input
                    type="search"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="Buscar produto no cardápio…"
                    className="mb-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                    aria-label="Buscar produto do cardápio"
                  />
                  <div className="max-h-60 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5">
                    {filteredProducts.length === 0 ? (
                      <p className="px-2 py-3 text-sm text-slate-500">
                        {activeProducts.length === 0
                          ? "Nenhum produto ativo no cardápio. Ative um produto para usá-lo como prêmio."
                          : "Nenhum produto encontrado para esta busca."}
                      </p>
                    ) : (
                      filteredProducts.map((product) => {
                        const selected = form.rewardProductIds.includes(
                          product.id
                        );
                        return (
                          <label
                            key={product.id}
                            className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
                              selected
                                ? "bg-amber-50 text-amber-900"
                                : "text-slate-800 hover:bg-slate-50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleRewardProduct(product.id)}
                              className="h-4 w-4 shrink-0 rounded border-slate-300 text-amber-500 focus:ring-amber-400"
                            />
                            <span className="flex-1 truncate">
                              {product.name}
                            </span>
                            <span className="shrink-0 text-xs text-slate-500">
                              {formatCouponBRL(Number(product.price) || 0)}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Apenas produtos ativos aparecem aqui.{" "}
                    {form.rewardProductIds.length === 0
                      ? "Selecione ao menos 1 produto — o cliente escolhe entre eles no resgate."
                      : `${form.rewardProductIds.length} produto${
                          form.rewardProductIds.length === 1 ? "" : "s"
                        } habilitado${
                          form.rewardProductIds.length === 1 ? "" : "s"
                        } — o cliente escolhe ${
                          Number(form.rewardProductQuantity) || 1
                        } no resgate.`}
                  </p>

                  <div className="mt-3 max-w-xs">
                    <label
                      htmlFor="fidelidade-quantidade-premio"
                      className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Quantidade de produtos grátis que o cliente ganha
                    </label>
                    <input
                      id="fidelidade-quantidade-premio"
                      type="number"
                      min={1}
                      max={LOYALTY_MAX_REWARD_PRODUCT_QUANTITY}
                      step={1}
                      value={form.rewardProductQuantity}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          rewardProductQuantity: e.target.value,
                        }))
                      }
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Ex.: 1 = &quot;ganhe 1 produto grátis&quot;; 2 = &quot;ganhe 2
                      produtos grátis&quot;. O cliente pode repetir o mesmo produto.
                    </p>
                  </div>
                </div>
              )}

              {!needsRewardProduct && (
              <div>
                <label
                  htmlFor="fidelidade-valor-premio"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  {form.rewardType === "percentage_discount"
                    ? "Percentual do prêmio (%)"
                    : "Valor do prêmio (R$)"}
                </label>
                <input
                  id="fidelidade-valor-premio"
                  type="number"
                  min={0}
                  max={
                    form.rewardType === "percentage_discount"
                      ? 100
                      : LOYALTY_MAX_REWARD_VALUE
                  }
                  step="0.01"
                  disabled={form.rewardType === "free_shipping"}
                  value={
                    form.rewardType === "free_shipping" ? "" : form.rewardValue
                  }
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      rewardValue: e.target.value,
                    }))
                  }
                  placeholder={
                    form.rewardType === "free_shipping" ? "Frete grátis" : "10,00"
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500 disabled:bg-slate-100 disabled:text-slate-500"
                />
              </div>
              )}

              <div>
                <label
                  htmlFor="fidelidade-pedido-minimo"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Pedido mínimo para resgatar (R$)
                </label>
                <input
                  id="fidelidade-pedido-minimo"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.minOrderValue}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      minOrderValue: e.target.value,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Use 0 para permitir o resgate em qualquer valor.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={!selectedId || isSaving}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSaving ? "Salvando…" : "Salvar programa"}
              </button>
              <span className="text-xs text-slate-500">
                Alterações valem para os próximos pedidos.
              </span>
            </div>
          </form>

          <aside className="flex h-fit flex-col gap-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">
                Resumo do prêmio
              </p>
              <p className="mt-1 text-lg font-bold text-slate-900">
                {nextRewardPreview.rewardLabel}
              </p>
              <p className="mt-1 text-sm text-slate-700">
                {nextRewardPreview.isOrdersMode ? (
                  <>
                    A {nextRewardPreview.goalLabel} o cliente ganha o prêmio.
                  </>
                ) : (
                  <>
                    A cada <strong>{nextRewardPreview.goalLabel}</strong> o
                    cliente troca por um prêmio.
                  </>
                )}
              </p>
              <p className="mt-1 text-xs font-semibold text-amber-800">
                {nextRewardPreview.ruleLabel}
              </p>
            </div>

            {nextRewardPreview.missingProduct && (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
              >
                Selecione ao menos 1 produto do prêmio para salvar — sem ele o
                checkout não tem o que entregar.
              </p>
            )}

            {nextRewardPreview.isOrdersMode &&
              !nextRewardPreview.missingProduct && (
                <div className="rounded-xl bg-white/80 p-3 text-sm text-slate-700">
                  <p>
                    Opções para o cliente:{" "}
                    <strong>{nextRewardPreview.productCount}</strong> produto
                    {nextRewardPreview.productCount === 1 ? "" : "s"} · ele
                    escolhe{" "}
                    <strong>{nextRewardPreview.productQuantity}</strong> no
                    resgate.
                  </p>
                </div>
              )}

            <div className="rounded-xl bg-white/80 p-3 text-sm text-slate-700">
              <p>
                Cliente novo precisa de{" "}
                <strong>{nextRewardPreview.firstReward}</strong> para o primeiro
                prêmio.
              </p>
            </div>

            <div className="rounded-xl bg-white/80 p-3 text-sm text-slate-700">
              {Number(form.minOrderValue) > 0 ? (
                <p>
                  Resgate liberado apenas em pedidos a partir de{" "}
                  <strong>
                    {formatCouponBRL(Number(form.minOrderValue) || 0)}
                  </strong>
                  .
                </p>
              ) : (
                <p>Resgate liberado em pedidos de qualquer valor.</p>
              )}
            </div>

            <div className="rounded-xl bg-white/80 p-3 text-xs leading-relaxed text-slate-600">
              <p className="font-semibold text-slate-800">Como funciona</p>
              <ol className="mt-1 list-decimal space-y-1 pl-4">
                {nextRewardPreview.isOrdersMode ? (
                  <>
                    <li>
                      Cada pedido finalizado conta 1 no ciclo do cliente.
                    </li>
                    <li>
                      Ao fechar o ciclo, o prêmio fica disponível no checkout e o
                      cliente escolhe os itens entre os produtos habilitados.
                    </li>
                    <li>
                      Pedido cancelado devolve a contagem e o prêmio usado.
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      Pedido finalizado credita os pontos automaticamente.
                    </li>
                    <li>
                      Pedido cancelado estorna os pontos ganhos e devolve os
                      resgatados.
                    </li>
                    <li>O cliente escolhe resgatar no checkout do cardápio.</li>
                  </>
                )}
              </ol>
            </div>
          </aside>
        </div>

        <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Ajuste manual de pontos
            </h2>
            <p className="text-sm text-slate-600">
              Use para corrigir saldos em casos de suporte. Cada ajuste fica
              registrado no extrato do cliente.
            </p>
          </div>

          <form onSubmit={handleAdjust} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label
                htmlFor="fidelidade-ajuste-telefone"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Telefone
              </label>
              <input
                id="fidelidade-ajuste-telefone"
                type="tel"
                inputMode="tel"
                required
                value={adjustPhone}
                onChange={(e) =>
                  setAdjustPhone(formatPhoneInput(e.target.value))
                }
                placeholder="(11) 99999-9999"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
              />
            </div>

            <div>
              <label
                htmlFor="fidelidade-ajuste-nome"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Nome (opcional)
              </label>
              <input
                id="fidelidade-ajuste-nome"
                type="text"
                value={adjustName}
                onChange={(e) => setAdjustName(e.target.value)}
                placeholder="Nome do cliente"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
              />
            </div>

            <div>
              <label
                htmlFor="fidelidade-ajuste-tipo"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Operação
              </label>
              <select
                id="fidelidade-ajuste-tipo"
                value={adjustMode}
                onChange={(e) =>
                  setAdjustMode(e.target.value === "remove" ? "remove" : "add")
                }
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
              >
                <option value="add">Adicionar pontos</option>
                <option value="remove">Remover pontos</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="fidelidade-ajuste-pontos"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Pontos
              </label>
              <input
                id="fidelidade-ajuste-pontos"
                type="number"
                min={1}
                step={1}
                required
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                placeholder="100"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
              />
            </div>

            <div>
              <label
                htmlFor="fidelidade-ajuste-motivo"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Motivo (opcional)
              </label>
              <input
                id="fidelidade-ajuste-motivo"
                type="text"
                value={adjustDescription}
                onChange={(e) => setAdjustDescription(e.target.value)}
                placeholder="Ex.: pedido antigo não creditado"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500"
              />
            </div>

            <div className="flex items-end sm:col-span-2 lg:col-span-5">
              <button
                type="submit"
                disabled={!selectedId || isAdjusting}
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isAdjusting ? "Aplicando…" : "Aplicar ajuste"}
              </button>
            </div>
          </form>

          {adjustError && (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {adjustError}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
            <h2 className="text-lg font-bold text-slate-900">
              Participantes
            </h2>
            <p className="text-xs text-slate-500">
              {participants.length} cliente(s) com pontos nesta loja
            </p>
          </div>

          {isLoading ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              Carregando participantes…
            </p>
          ) : participants.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              Nenhum cliente pontuou ainda. Os pontos aparecem aqui assim que um
              pedido for finalizado.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3">Telefone</th>
                    <th className="px-4 py-3 text-right">
                      {program.reward_mode === "orders" ? "Pedidos" : "Saldo"}
                    </th>
                    <th className="px-4 py-3 text-right">
                      {program.reward_mode === "orders"
                        ? "Prêmios disponíveis"
                        : "Total ganho"}
                    </th>
                    <th className="px-4 py-3 text-right">Resgates</th>
                    <th className="px-4 py-3">Atualizado</th>
                    <th className="px-4 py-3 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {participants.map((account) => (
                    <tr
                      key={account.phone}
                      className={
                        historyPhone === account.phone ? "bg-amber-50/60" : ""
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-800">
                        {account.name || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-700">
                        {formatPhone(account.phone)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums text-amber-600">
                        {program.reward_mode === "orders"
                          ? account.orders_count
                          : account.balance}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-700">
                        {program.reward_mode === "orders"
                          ? account.free_rewards_available
                          : account.total_earned}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-700">
                        {account.rewards_redeemed}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">
                        {formatDateTime(account.updated_at)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void loadHistory(account.phone)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 transition hover:border-amber-300 hover:text-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                          >
                            Extrato
                          </button>
                          <button
                            type="button"
                            onClick={() => startAdjustFor(account)}
                            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 transition hover:border-emerald-400/50 hover:text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                          >
                            Ajustar
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {historyPhone && (
          <section className="flex flex-col gap-3 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  Extrato de pontos
                </h2>
                <p className="text-xs text-slate-500">
                  {formatPhone(historyPhone)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setHistoryPhone(null);
                  setTransactions([]);
                  setHistoryError(null);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 transition hover:bg-slate-100"
              >
                Fechar extrato
              </button>
            </div>

            {historyError ? (
              <p
                role="alert"
                className="px-5 py-6 text-sm text-red-700"
              >
                {historyError}
              </p>
            ) : isLoadingHistory ? (
              <p className="px-5 py-6 text-center text-sm text-slate-500">
                Carregando extrato…
              </p>
            ) : transactions.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-slate-500">
                Nenhuma movimentação registrada para este telefone.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Data</th>
                      <th className="px-4 py-3">Movimento</th>
                      <th className="px-4 py-3 text-right">Pontos</th>
                      <th className="px-4 py-3 text-right">Saldo após</th>
                      <th className="px-4 py-3">Descrição</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {transactions.map((transaction) => (
                      <tr key={transaction.id}>
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600">
                          {formatDateTime(transaction.created_at)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-800">
                          {transactionKindLabel(transaction.kind)}
                        </td>
                        <td
                          className={`whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums ${
                            transaction.points >= 0
                              ? "text-emerald-600"
                              : "text-red-600"
                          }`}
                        >
                          {transaction.points > 0 ? "+" : ""}
                          {transaction.points}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-700">
                          {transaction.balance_after}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {transaction.description ||
                            (transaction.order_id
                              ? `Pedido ${transaction.order_id.slice(0, 8)}`
                              : "—")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
