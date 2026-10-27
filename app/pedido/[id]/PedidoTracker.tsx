"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCart } from "@/context/CartContext";
import type { OrderStatus } from "@/lib/types";
import { normalizeOrderStatus } from "@/lib/types";
import {
  formatEstimatedDeliveryWindowLabel,
  parseEstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";
import { getCustomerProfile } from "@/lib/storage";
import { WhatsAppSendHint } from "@/app/components/WhatsAppSendHint";
import {
  clearPendingOrderWhatsAppUrl,
  readPendingOrderWhatsAppUrl,
} from "@/lib/whatsappOrder";

interface TrackerItem {
  name: string;
  quantity: number;
  line_total: number;
  addons?: Array<{ name: string }>;
}

interface TrackerOrder {
  id: string;
  status: OrderStatus;
  items: TrackerItem[];
  customer_address: {
    street?: string;
    number?: string;
    neighborhood?: string;
    complement?: string;
    reference?: string;
  } | null;
  subtotal: number;
  delivery_fee: number;
  total: number;
  payment_method: string;
  notes: string | null;
  cancellation_reason: string | null;
  estimated_delivery_time: string | null;
  estimated_delivery_at: string | null;
  created_at: string;
}

const STATUS_META: Record<OrderStatus, { emoji: string; title: string; text: string; ring: string }> = {
  pendente: {
    emoji: "🟡",
    title: "Pedido recebido",
    text: "Aguardando confirmação do restaurante...",
    ring: "border-yellow-400/40 bg-yellow-400/10",
  },
  preparando: {
    emoji: "🔵",
    title: "Em preparo",
    text: "Seu pedido está sendo preparado!",
    ring: "border-sky-400/40 bg-sky-400/10",
  },
  entrega: {
    emoji: "🟣",
    title: "Saiu para entrega",
    text: "Seu pedido saiu para entrega!",
    ring: "border-violet-400/40 bg-violet-400/10",
  },
  finalizado: {
    emoji: "🟢",
    title: "Pedido entregue",
    text: "Pedido entregue. Bom apetite!",
    ring: "border-emerald-400/40 bg-emerald-400/10",
  },
  cancelado: {
    emoji: "🔴",
    title: "Pedido cancelado",
    text: "O pedido foi cancelado.",
    ring: "border-red-500/40 bg-red-500/10",
  },
};

const PAYMENT_LABEL: Record<string, string> = {
  pix: "Pix",
  cartao: "Cartão na entrega",
  dinheiro: "Dinheiro",
};

/** Chaves onde o telefone do cliente pode estar salvo (perfil + legado). */
const CUSTOMER_PHONE_KEYS = ["customer_phone", "delivery_last_phone"];

/**
 * Recupera o WhatsApp do cliente salvo no navegador (somente dígitos).
 * É usado como prova de posse ao cancelar: o servidor confere o telefone
 * informado com o telefone gravado no pedido.
 */
function readSavedCustomerPhone(): string {
  if (typeof window === "undefined") return "";

  const profilePhone = getCustomerProfile()?.phone ?? "";
  const profileDigits = profilePhone.replace(/\D/g, "");
  if (profileDigits) return profileDigits;

  for (const key of CUSTOMER_PHONE_KEYS) {
    try {
      const digits = (window.localStorage.getItem(key) ?? "").replace(/\D/g, "");
      if (digits) return digits;
    } catch {
      // localStorage indisponível (modo privado/quota) — ignora.
    }
  }
  return "";
}

function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

/** Horário previsto legível ("hoje às 19:40" / "24/10 às 19:40"). */
function formatEstimatedAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (isToday) return `hoje às ${time}`;
  const day = date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
  return `${day} às ${time}`;
}

function normalizeTracker(raw: unknown): TrackerOrder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const status = normalizeOrderStatus(r.status);
  if (typeof r.id !== "string" || !status) return null;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    id: r.id,
    status,
    items: items.map((it) => {
      const o = (typeof it === "object" && it !== null ? it : {}) as Record<string, unknown>;
      return {
        name: typeof o.name === "string" ? o.name : "Item",
        quantity: Math.max(1, Math.floor(num(o.quantity ?? 1))),
        line_total: num(o.line_total),
        addons: Array.isArray(o.addons)
          ? (o.addons as Array<{ name?: unknown }>)
              .filter((a) => typeof a?.name === "string")
              .map((a) => ({ name: String((a as { name: string }).name) }))
          : [],
      };
    }),
    customer_address:
      r.customer_address && typeof r.customer_address === "object"
        ? (r.customer_address as TrackerOrder["customer_address"])
        : null,
    subtotal: num(r.subtotal),
    delivery_fee: num(r.delivery_fee),
    total: num(r.total),
    payment_method: typeof r.payment_method === "string" ? r.payment_method : "—",
    notes: typeof r.notes === "string" ? r.notes : null,
    cancellation_reason:
      typeof r.cancellation_reason === "string" ? r.cancellation_reason : null,
    estimated_delivery_time:
      typeof r.estimated_delivery_time === "string"
        ? r.estimated_delivery_time
        : null,
    estimated_delivery_at:
      typeof r.estimated_delivery_at === "string"
        ? r.estimated_delivery_at
        : null,
    created_at: typeof r.created_at === "string" ? r.created_at : "",
  };
}

/**
 * `true` quando a resposta do polling é igual ao estado atual.
 *
 * O acompanhamento consulta o pedido a cada 10s (+ Realtime). Sem essa
 * comparação o estado seria recriado a cada resposta e a tela re-renderizaria
 * sem nenhuma mudança real, embaralhando animações e o resumo do WhatsApp.
 * `normalizeTracker` devolve sempre as mesmas chaves (ordem estável), então a
 * comparação por JSON é determinística.
 */
function isSameTrackerOrder(
  current: TrackerOrder | null,
  next: TrackerOrder
): boolean {
  return current !== null && JSON.stringify(current) === JSON.stringify(next);
}

/** Componente interativo: busca inicial + Realtime + polling de fallback. */
export function PedidoTracker({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { clearCart } = useCart();
  const [order, setOrder] = useState<TrackerOrder | null>(null);
  const [estName, setEstName] = useState("Restaurante");
  const [whatsapp, setWhatsapp] = useState<string | null>(null);
  /**
   * Link do resumo do pedido no WhatsApp, gerado pelo checkout e transportado
   * via `sessionStorage` (o checkout redireciona para cá). `null` quando a loja
   * desativou o recurso, não tem número válido ou o pedido saiu de `pendente`.
   */
  const [dismissedWhatsAppUrl, setDismissedWhatsAppUrl] = useState<string | null>(
    null
  );
  const [estSlug, setEstSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [justUpdated, setJustUpdated] = useState(false);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const [cancelPhone, setCancelPhone] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const supabase = useRef(createClient());
  const prevStatus = useRef<OrderStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/order-status?id=${encodeURIComponent(orderId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Falha ao carregar o pedido.");
      const parsed = normalizeTracker(data.order);
      if (!parsed) throw new Error("Resposta inválida do servidor.");
      if (prevStatus.current !== null && prevStatus.current !== parsed.status) {
        setJustUpdated(true);
        window.setTimeout(() => setJustUpdated(false), 4000);
      }
      prevStatus.current = parsed.status;
      // Atualiza os dados em silêncio: o polling/Realtime NÃO pode reexibir o
      // estado "Carregando pedido..." (reservado à primeira carga).
      setOrder((prev) => (isSameTrackerOrder(prev, parsed) ? prev : parsed));
      if (data.establishment && typeof data.establishment === "object") {
        const est = data.establishment as { name?: unknown; whatsapp?: unknown; slug?: unknown };
        if (typeof est.name === "string" && est.name) setEstName(est.name);
        setWhatsapp(typeof est.whatsapp === "string" && est.whatsapp ? est.whatsapp : null);
        // Slug público da loja — alimenta o link "Voltar ao cardápio" (/[slug]).
        setEstSlug(typeof est.slug === "string" && est.slug ? est.slug : null);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      // Encerra apenas o loading da PRIMEIRA carga. As buscas seguintes
      // (polling de 10s e Realtime) são silenciosas por definição.
      setIsLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void (async () => {
      await fetchStatus();
    })();
  }, [fetchStatus]);

  useEffect(() => {
    const id = window.setInterval(fetchStatus, 10000);
    return () => window.clearInterval(id);
  }, [fetchStatus]);

  useEffect(() => {
    const client = supabase.current;
    const channel = client
      .channel(`pedido-${orderId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
        () => fetchStatus()
      )
      .subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [orderId, fetchStatus]);

  /**
   * Link do resumo no WhatsApp: derivado do pedido + `sessionStorage` (sem
   * efeito, evitando renders em cascata). Só faz sentido enquanto o pedido está
   * `pendente` — depois disso a loja já confirmou/iniciou o preparo. O helper
   * valida se a URL salva pertence a este pedido, evitando o resumo de uma
   * compra anterior. `dismissedWhatsAppUrl` esconde o card após o clique.
   */
  const orderStatus = order?.status ?? null;
  const storedWhatsAppUrl = useMemo(
    () =>
      orderStatus === "pendente" ? readPendingOrderWhatsAppUrl(orderId) : null,
    [orderId, orderStatus]
  );
  const orderWhatsAppUrl =
    storedWhatsAppUrl && storedWhatsAppUrl !== dismissedWhatsAppUrl
      ? storedWhatsAppUrl
      : null;

  /**
   * Link "Voltar ao cardápio": aponta para a vitrine da loja do pedido (/[slug]).
   * Fallback para a raiz quando o slug ainda não chegou (carregamento inicial)
   * ou quando a base é legada e a coluna `slug` está vazia — a raiz resolve a
   * primeira loja ativa (mesmo fallback do AdminHeader).
   */
  const menuHref = estSlug ? `/${estSlug}` : "/";

  const waHref = useMemo(() => {
    if (!whatsapp || !order) return null;
    const lines = order.items.map((it) => `- ${it.quantity}x ${it.name}`).join("\n");
    const text = `Olá, ${estName}! Fiz o pedido ${order.id.slice(0, 8)}:\n${lines}\nTotal: ${formatBRL(order.total)}. Gostaria de acompanhar o status.`;
    return `https://wa.me/${whatsapp}?text=${encodeURIComponent(text)}`;
  }, [whatsapp, order, estName]);

  /**
   * "Fazer outro pedido": encerra a compra anterior — limpa o carrinho global
   * (estado + localStorage) e volta para a vitrine da loja. O histórico do
   * pedido continua acessível pela rota `/pedido/[id]` e por "Meus Pedidos".
   */
  const startNewOrder = () => {
    clearCart();
    router.push(menuHref);
  };

  /** Abre o diálogo de confirmação (só existe para pedidos pendentes). */
  const openCancelDialog = () => {
    // Pré-preenche com o telefone já usado no checkout, quando disponível.
    setCancelPhone(readSavedCustomerPhone());
    setCancelError(null);
    setIsCancelDialogOpen(true);
  };

  const closeCancelDialog = () => {
    if (isCancelling) return;
    setIsCancelDialogOpen(false);
    setCancelError(null);
  };

  /**
   * Confirma o cancelamento pelo cliente.
   *
   * O servidor valida a posse (uuid + telefone do pedido) e exige que o status
   * ainda seja `pendente`; a tela é atualizada na hora com a resposta.
   */
  const confirmCancel = async () => {
    if (!order || isCancelling) return;

    const phoneDigits = cancelPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      setCancelError("Informe o WhatsApp usado no pedido, com DDD.");
      return;
    }

    setIsCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch("/api/orders/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: order.id,
          customer_phone: phoneDigits,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        order?: { status?: string; cancellation_reason?: string | null };
      };
      if (!res.ok) {
        // 409 = o status mudou enquanto o cliente decidia; recarrega para a
        // tela refletir o estado real (e o botão desaparecer, se for o caso).
        if (res.status === 409) void fetchStatus();
        throw new Error(data.error ?? "Não foi possível cancelar o pedido.");
      }

      const cancelledReason =
        typeof data.order?.cancellation_reason === "string"
          ? data.order.cancellation_reason
          : null;
      setOrder((prev) =>
        prev
          ? { ...prev, status: "cancelado", cancellation_reason: cancelledReason }
          : prev
      );
      prevStatus.current = "cancelado";
      setJustUpdated(true);
      window.setTimeout(() => setJustUpdated(false), 4000);
      setIsCancelDialogOpen(false);
    } catch (err) {
      setCancelError(
        err instanceof Error ? err.message : "Erro inesperado ao cancelar."
      );
    } finally {
      setIsCancelling(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <p className="text-sm font-medium text-gray-400">Carregando pedido...</p>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-4 dark:bg-gray-950">
        <p className="text-sm text-red-400">{error ?? "Pedido não encontrado."}</p>
        <Link
          href={menuHref}
          className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white dark:bg-yellow-400 dark:text-gray-950"
        >
          Voltar ao cardápio
        </Link>
      </div>
    );
  }

  const meta = STATUS_META[order.status];
  const estimateWindow = parseEstimatedDeliveryWindow(
    order.estimated_delivery_time
  );
  const estimateLabel =
    estimateWindow != null
      ? formatEstimatedDeliveryWindowLabel(estimateWindow)
      : order.estimated_delivery_time;
  const estimatedAtLabel = formatEstimatedAt(order.estimated_delivery_at);
  const showEstimate =
    order.status !== "finalizado" &&
    order.status !== "cancelado" &&
    Boolean(estimateLabel || estimatedAtLabel);
  const addr = order.customer_address;
  const addrText = addr
    ? [addr.street && addr.number ? `${addr.street}, ${addr.number}` : addr.street, addr.neighborhood, addr.complement].filter(Boolean).join(" - ")
    : null;

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-8">
        <p className="text-center text-xs font-semibold uppercase tracking-widest text-gray-400">
          {estName} · Pedido {order.id.slice(0, 8)}
        </p>
        <section className={`rounded-2xl border p-6 text-center ${meta.ring}`}>
          <p className="text-4xl">{meta.emoji}</p>
          <h1 className="mt-2 text-xl font-bold text-gray-900 dark:text-white">{meta.title}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-300">{meta.text}</p>
          {showEstimate && (
            <div className="mt-4 rounded-xl border border-yellow-400/60 bg-yellow-50/90 p-3 text-left dark:border-yellow-400/40 dark:bg-yellow-400/10">
              <p className="text-[11px] font-bold uppercase tracking-wider text-yellow-700 dark:text-yellow-300">
                Previsão de entrega
              </p>
              <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">
                {order.status === "entrega"
                  ? estimatedAtLabel
                    ? `Seu pedido está a caminho — chega ${estimatedAtLabel}.`
                    : "Seu pedido está a caminho!"
                  : estimateLabel
                    ? `Chega em ${estimateLabel}.`
                    : "Previsão sendo atualizada pela loja."}
              </p>
              {estimatedAtLabel && order.status !== "entrega" && (
                <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">
                  Horário previsto: {estimatedAtLabel}
                </p>
              )}
            </div>
          )}
          {order.status === "cancelado" && order.cancellation_reason && (
            <p className="mt-3 rounded-xl border border-red-300/40 bg-red-500/10 px-3 py-2 text-left text-sm text-red-700 dark:border-red-500/30 dark:text-red-300">
              <span className="font-bold">Motivo: </span>
              {order.cancellation_reason}
            </p>
          )}
          {justUpdated && (
            <p className="mt-2 inline-block rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold text-emerald-300">
              Status atualizado agora ✓
            </p>
          )}
        </section>
        {/*
         * Resumo do pedido no WhatsApp: link montado no servidor no momento da
         * criação do pedido (respeita a preferência da loja). O pedido já está
         * no painel — o botão é apenas um atalho para enviar o comprovante.
         */}
        {orderWhatsAppUrl && (
          <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
              Resumo no WhatsApp
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
              Envie o pedido completo (itens, adicionais, endereço e valores)
              para o WhatsApp do restaurante.
            </p>
            <WhatsAppSendHint className="mt-4" />
            <a
              href={orderWhatsAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                clearPendingOrderWhatsAppUrl();
                setDismissedWhatsAppUrl(orderWhatsAppUrl);
              }}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500/40"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.13c-.25.69-1.44 1.32-1.99 1.4-.51.08-1.16.11-1.87-.12-.43-.14-.98-.32-1.69-.62-2.97-1.28-4.91-4.27-5.06-4.47-.15-.2-1.21-1.61-1.21-3.07 0-1.46.77-2.18 1.04-2.48.27-.3.59-.37.79-.37.2 0 .39 0 .57.01.18.01.43-.07.67.51.24.59.83 2.03.9 2.18.07.15.12.32.02.52-.1.2-.15.32-.3.5-.15.17-.31.39-.45.52-.15.15-.3.31-.13.61.17.3.76 1.25 1.63 2.02 1.12.99 2.06 1.3 2.36 1.45.3.15.47.12.65-.07.17-.2.76-.89.96-1.19.2-.3.4-.25.67-.15.27.1 1.72.81 2.02.96.3.15.5.22.57.35.07.12.07.72-.18 1.41Z" />
              </svg>
              Enviar resumo no WhatsApp
            </a>
          </section>
        )}
        <section className="rounded-2xl border border-gray-200/70 bg-white p-5 dark:border-gray-700/60 dark:bg-gray-800/60">
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">Resumo</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {order.items.map((it, i) => (
              <li key={`${order.id}-${i}`} className="flex justify-between gap-2 text-sm text-gray-700 dark:text-gray-200">
                <span className="font-medium">{it.quantity}x {it.name}</span>
                <span className="tabular-nums text-gray-400">{formatBRL(it.line_total)}</span>
              </li>
            ))}
          </ul>
          {addrText && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Entrega: {addrText}</p>}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Pagto: {PAYMENT_LABEL[order.payment_method] ?? order.payment_method}
          </p>
          <div className="mt-3 flex flex-col gap-1.5 border-t border-gray-200 pt-3 text-sm dark:border-gray-700">
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500 dark:text-gray-400">Subtotal</span>
              <span className="tabular-nums text-gray-700 dark:text-gray-200">
                {formatBRL(order.subtotal)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-500 dark:text-gray-400">
                Taxa de entrega
              </span>
              <span
                className={
                  order.delivery_fee > 0
                    ? "tabular-nums text-gray-700 dark:text-gray-200"
                    : "font-semibold text-emerald-600 dark:text-emerald-400"
                }
              >
                {order.delivery_fee > 0 ? formatBRL(order.delivery_fee) : "Grátis"}
              </span>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-gray-200 pt-3 dark:border-gray-700">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Total</span>
            <span className="text-base font-bold tabular-nums text-gray-900 dark:text-white">{formatBRL(order.total)}</span>
          </div>
        </section>
        {/*
         * Cancelamento pelo cliente: o botão só existe enquanto o pedido está
         * `pendente`. Depois disso a loja já pode ter iniciado o preparo, então
         * mostramos apenas a orientação para falar no WhatsApp.
         */}
        {order.status === "pendente" ? (
          <section className="rounded-2xl border border-red-200/70 bg-white p-5 dark:border-red-500/30 dark:bg-gray-800/60">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400">
              Cancelar pedido
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              Você pode cancelar enquanto o restaurante ainda não confirmou o
              pedido.
            </p>
            <button
              type="button"
              onClick={openCancelDialog}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-red-300 bg-white px-4 py-3 text-sm font-semibold text-red-600 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-400/40 dark:border-red-500/40 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-500/10"
            >
              Cancelar pedido
            </button>
          </section>
        ) : (
          <p className="rounded-2xl border border-gray-200/70 bg-white px-4 py-3 text-xs leading-relaxed text-gray-500 dark:border-gray-700/60 dark:bg-gray-800/60 dark:text-gray-400">
            {order.status === "cancelado"
              ? "Este pedido já foi cancelado."
              : "Este pedido não pode mais ser cancelado pelo sistema pois já está em andamento."}{" "}
            Caso precise, entre em contato via WhatsApp
            {waHref ? (
              <>
                {" "}
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-green-600 underline underline-offset-2 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                >
                  Falar no WhatsApp
                </a>
                .
              </>
            ) : (
              "."
            )}
          </p>
        )}
        {waHref && (
          <a href={waHref} target="_blank" rel="noopener noreferrer" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white hover:bg-green-700">
            Falar no WhatsApp do Restaurante
          </a>
        )}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={startNewOrder}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
          >
            Fazer outro pedido
          </button>
          <Link
            href={menuHref}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-100 dark:border-gray-700 dark:bg-transparent dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Voltar ao cardápio
          </Link>
        </div>
      </main>

      {isCancelDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-order-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeCancelDialog();
          }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-800">
            <h2
              id="cancel-order-title"
              className="text-base font-bold text-gray-900 dark:text-white"
            >
              Cancelar pedido?
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              Tem certeza que deseja cancelar este pedido? Esta ação não pode ser
              desfeita.
            </p>

            <label
              htmlFor="cancel-order-phone"
              className="mt-4 block text-xs font-semibold text-gray-700 dark:text-gray-300"
            >
              WhatsApp usado no pedido
            </label>
            <input
              id="cancel-order-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="(11) 99999-9999"
              value={cancelPhone}
              onChange={(event) => {
                setCancelPhone(event.target.value);
                if (cancelError) setCancelError(null);
              }}
              disabled={isCancelling}
              className="mt-1.5 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-400/30 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />

            {cancelError && (
              <p
                role="alert"
                className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-300"
              >
                {cancelError}
              </p>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={confirmCancel}
                disabled={isCancelling}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCancelling ? "Cancelando..." : "Sim, cancelar pedido"}
              </button>
              <button
                type="button"
                onClick={closeCancelDialog}
                disabled={isCancelling}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400/40 disabled:opacity-60 dark:border-gray-700 dark:bg-transparent dark:text-gray-200 dark:hover:bg-gray-700/60"
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
