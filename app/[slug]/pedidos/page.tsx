"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  formatEstimatedDeliveryWindowLabel,
  parseEstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";

type OrderStatus = "pendente" | "preparando" | "entrega" | "finalizado" | "cancelado";

interface OrderItem {
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  addons?: Array<{ id: string; name: string; price: number }>;
}

interface OrderCard {
  id: string;
  status: OrderStatus;
  total: number;
  subtotal: number;
  delivery_fee: number;
  payment_method: string;
  customer_name: string;
  customer_phone: string | null;
  customer_address: { street?: string; number?: string; neighborhood?: string; complement?: string; reference?: string } | null;
  items: OrderItem[];
  cancellation_reason?: string | null;
  estimated_delivery_time?: string | null;
  estimated_delivery_at?: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<OrderStatus, string> = {
  pendente: "Pendente",
  preparando: "Em preparo",
  entrega: "Saiu para entrega",
  finalizado: "Concluído",
  cancelado: "Cancelado",
};

const STATUS_BADGE: Record<OrderStatus, string> = {
  pendente: "bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:ring-amber-800",
  preparando: "bg-sky-100 text-sky-800 ring-sky-200 dark:bg-sky-900/40 dark:text-sky-200 dark:ring-sky-800",
  entrega: "bg-violet-100 text-violet-800 ring-violet-200 dark:bg-violet-900/40 dark:text-violet-200 dark:ring-violet-800",
  finalizado: "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:ring-emerald-800",
  cancelado: "bg-red-100 text-red-800 ring-red-200 dark:bg-red-900/40 dark:text-red-200 dark:ring-red-800",
};

const STATUS_DOT: Record<OrderStatus, string> = {
  pendente: "bg-amber-500",
  preparando: "bg-sky-500",
  entrega: "bg-violet-500",
  finalizado: "bg-emerald-500",
  cancelado: "bg-red-500",
};

const PAYMENT_LABEL: Record<string, string> = {
  pix: "Pix",
  cartao: "Cartão na entrega",
  dinheiro: "Dinheiro",
};

/** Chave usada no localStorage para o telefone do cliente. */
const CUSTOMER_PHONE_KEY = "customer_phone";
/** Chave legada mantida como fallback para compatibilidade. */
const LEGACY_PHONE_KEY = "delivery_last_phone";

function formatBRL(value: number): string {
  return "R$ " + Number(value).toFixed(2).replace(".", ",");
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Rótulo amigável da previsão ("30 a 45 min"), com fallback para o texto cru. */
function estimateLabel(value?: string | null): string | null {
  if (!value) return null;
  const window = parseEstimatedDeliveryWindow(value);
  return window ? formatEstimatedDeliveryWindowLabel(window) : value;
}

/** Aplica máscara `(XX) XXXXX-XXXX` ao digitar. */
function formatPhoneInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length === 0) return "";
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10)
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

/** Remove caracteres não numéricos para consulta ao banco. */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function OrdersHistoryPage() {
  const params = useParams();
  const slug = params.slug as string | undefined;

  const [inputPhone, setInputPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [results, setResults] = useState<OrderCard[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Busca pedidos na API para um telefone informado. */
  const fetchOrders = useCallback(
    async (phoneValue: string) => {
      const cleaned = digitsOnly(phoneValue);
      if (cleaned.length < 10) return;
      setLoading(true);
      setError(null);
      setResults(null);
      try {
        const q = new URLSearchParams();
        // Envia somente dígitos; a API normaliza o valor salvo também.
        q.set("phone", cleaned);
        q.set("establishment_id", slug ?? "");
        const res = await fetch("/api/orders/customer?" + q.toString(), {
          cache: "no-store",
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          orders?: OrderCard[];
        };
        if (res.status === 400) {
          setError(body.error ?? "Dados inválidos.");
        } else if (res.status === 404) {
          setError("Nenhum pedido encontrado para este telefone nesta loja.");
        } else if (!res.ok) {
          setError(body.error ?? "Erro ao consultar a base de pedidos.");
        } else {
          setResults(body.orders ?? []);
        }
      } catch {
        setError("Não foi possível conectar ao servidor. Tente novamente.");
      } finally {
        setLoading(false);
      }
    },
    [slug]
  );

  // Ao montar: verifica telefone salvo no localStorage.
  // Se existir → busca automaticamente; senão → exibe formulário.
  useEffect(() => {
    let cancelled = false;
    // IIFE assíncrona para manter as atualizações de estado fora do corpo
    // síncrono do efeito (react-hooks/set-state-in-effect).
    void (async () => {
      try {
        const saved =
          localStorage.getItem(CUSTOMER_PHONE_KEY) ||
          localStorage.getItem(LEGACY_PHONE_KEY);
        if (cancelled) return;
        if (saved && digitsOnly(saved).length >= 10) {
          setSavedPhone(saved);
          setInputPhone(saved);
          await fetchOrders(saved);
        } else {
          setShowInput(true);
        }
        setInitialized(true);
      } catch {
        if (!cancelled) {
          setShowInput(true);
          setInitialized(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchOrders]);

  const handleSearch = () => {
    const cleaned = digitsOnly(inputPhone);
    if (cleaned.length < 10) {
      setError("Informe um telefone válido com DDD (mínimo 10 dígitos).");
      return;
    }
    // Salva para próximos acessos.
    try {
      localStorage.setItem(CUSTOMER_PHONE_KEY, inputPhone.trim());
    } catch {
      /* armazenamento indisponível */
    }
    setSavedPhone(inputPhone.trim());
    setShowInput(false);
    void fetchOrders(inputPhone);
  };

  const handleChangeNumber = () => {
    try {
      localStorage.removeItem(CUSTOMER_PHONE_KEY);
      localStorage.removeItem(LEGACY_PHONE_KEY);
    } catch {
      /* armazenamento indisponível */
    }
    setSavedPhone("");
    setInputPhone("");
    setResults(null);
    setError(null);
    setShowInput(true);
  };

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 py-6 sm:px-6">
      {/* Botão Voltar ao Cardápio */}
      <Link
        href={`/${slug}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
      >
        <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
        </svg>
        Voltar ao cardápio
      </Link>

      <header className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white sm:text-3xl">
          Meus Pedidos
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Acompanhe o histórico dos seus pedidos
        </p>
      </header>

      {/* Badge de telefone ativo + botão trocar */}
      {savedPhone && !showInput && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-2.5 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
            </svg>
            <span className="font-medium">{formatPhoneInput(savedPhone)}</span>
          </div>
          <button
            type="button"
            onClick={handleChangeNumber}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          >
            <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            Trocar número
          </button>
        </div>
      )}

      {/* Formulário de telefone (quando não há salvo ou usuário pediu troca) */}
      {showInput && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <label
            htmlFor="phone-input"
            className="block text-sm font-semibold text-gray-700 dark:text-gray-300"
          >
            Digite seu telefone
          </label>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Use o mesmo número informado no pedido
          </p>
          <div className="mt-3 flex gap-2">
            <input
              id="phone-input"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="(00) 00000-0000"
              value={inputPhone}
              onChange={(e) => setInputPhone(formatPhoneInput(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSearch();
                }
              }}
              className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm tabular-nums text-gray-900 placeholder-gray-400 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500 dark:focus:ring-gray-700"
            />
            <button
              type="button"
              onClick={handleSearch}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
            >
              {loading ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg>
              )}
              Buscar
            </button>
          </div>
        </div>
      )}

      {/* Indicador de carregamento */}
      {loading && (
        <div className="mt-6 flex flex-col items-center gap-3 py-8">
          <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-gray-300 border-t-gray-900 dark:border-gray-600 dark:border-t-yellow-400" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Buscando seus pedidos…
          </p>
        </div>
      )}

      {/* Erro */}
      {error && !loading && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Lista de pedidos */}
      {results !== null && results.length > 0 && !loading && (
        <div className="mt-6">
          <p className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {results.length} pedido{results.length > 1 ? "s" : ""} encontrado
            {results.length > 1 ? "s" : ""}
          </p>
          <ul className="flex flex-col gap-4">
            {results.map((order) => (
              <li
                key={order.id}
                className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition hover:shadow-md dark:border-gray-700 dark:bg-gray-900"
              >
                {/* Cabeçalho do card: badge + data */}
                <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 dark:border-gray-800">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[order.status]}`}
                      aria-hidden="true"
                    />
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ${STATUS_BADGE[order.status]}`}
                    >
                      {STATUS_LABEL[order.status]}
                    </span>
                  </div>
                  <span className="text-xs tabular-nums text-gray-400 dark:text-gray-500">
                    {formatDate(order.created_at)}
                  </span>
                </div>

                {order.status !== "finalizado" &&
                  order.status !== "cancelado" &&
                  estimateLabel(order.estimated_delivery_time) && (
                    <div className="mx-5 mt-3 rounded-xl border border-yellow-300/60 bg-yellow-50 px-3 py-2 dark:border-yellow-400/30 dark:bg-yellow-400/10">
                      <p className="text-xs font-bold uppercase tracking-wider text-yellow-700 dark:text-yellow-300">
                        Previsão de entrega
                      </p>
                      <p className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-white">
                        {order.status === "entrega"
                          ? `Seu pedido está a caminho — chega em ${estimateLabel(order.estimated_delivery_time)}.`
                          : `Chega em ${estimateLabel(order.estimated_delivery_time)}.`}
                      </p>
                    </div>
                  )}

                {/* Itens do pedido */}
                {order.items.length > 0 && (
                  <div className="px-5 pt-4">
                    <p className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                      Itens
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {order.items.map((it, idx) => (
                        <li
                          key={`${order.id}-${idx}`}
                          className="flex items-start justify-between gap-3 text-sm"
                        >
                          <span className="text-gray-700 dark:text-gray-200">
                            <span className="font-bold tabular-nums text-gray-900 dark:text-white">
                              {it.quantity}×
                            </span>{" "}
                            {it.name}
                            {it.addons && it.addons.length > 0 && (
                              <span className="block text-xs text-gray-400 dark:text-gray-500">
                                + {it.addons.map((a) => a.name).join(", ")}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
                            {formatBRL(it.line_total)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Motivo do cancelamento (visível ao cliente) */}
                {order.status === "cancelado" && order.cancellation_reason && (
                  <div className="mx-5 mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                    <span className="font-bold">Motivo do cancelamento: </span>
                    {order.cancellation_reason}
                  </div>
                )}

                {/* Resumo financeiro */}
                <div className="mt-4 space-y-1 border-t border-gray-100 px-5 py-3 dark:border-gray-800">
                  <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
                    <span>Subtotal</span>
                    <span className="tabular-nums">{formatBRL(order.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500">
                    <span>Taxa de entrega</span>
                    <span className="tabular-nums">
                      {order.delivery_fee > 0
                        ? formatBRL(order.delivery_fee)
                        : "Grátis"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1 text-sm font-bold text-gray-900 dark:text-white">
                    <span>Total</span>
                    <span className="tabular-nums">{formatBRL(order.total)}</span>
                  </div>
                  {order.payment_method && (
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {PAYMENT_LABEL[order.payment_method] ?? order.payment_method}
                    </p>
                  )}
                </div>

                {/* Endereço de entrega */}
                {order.customer_address && (
                  <div className="border-t border-gray-100 px-5 py-3 dark:border-gray-800">
                    <p className="text-xs font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                      Entrega
                    </p>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                      {[
                        order.customer_address.street && order.customer_address.number
                          ? `${order.customer_address.street}, ${order.customer_address.number}`
                          : order.customer_address.street,
                        order.customer_address.neighborhood,
                        order.customer_address.complement,
                        order.customer_address.reference,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                )}

                {/* Ação: ver detalhes */}
                <div className="border-t border-gray-100 px-5 py-3 dark:border-gray-800">
                  <Link
                    href={`/pedido/${order.id}`}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                    </svg>
                    Ver detalhes
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Estado vazio: sem resultados mas já buscou */}
      {results !== null && results.length === 0 && !loading && !error && (
        <div className="mt-6 rounded-2xl border border-dashed border-gray-300 bg-white/60 p-10 text-center dark:border-gray-700 dark:bg-gray-900/40">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
            <svg aria-hidden="true" className="h-6 w-6 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
          </span>
          <p className="mt-3 text-sm font-semibold text-gray-600 dark:text-gray-300">
            Nenhum pedido encontrado
          </p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Verifique se o telefone está correto ou faça um novo pedido.
          </p>
        </div>
      )}

      {/* Estado inicial: aguardando telefone (antes de qualquer coisa) */}
      {!initialized && (
        <div className="mt-8 flex justify-center py-6">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900 dark:border-gray-600 dark:border-t-yellow-400" />
        </div>
      )}
    </div>
  );
}

/**
 * Wrapper com Suspense: `useParams()` só está disponível em runtime, então o
 * componente que o usa precisa ser isolado para permitir o prerender da rota.
 */
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900 dark:border-gray-600 dark:border-t-yellow-400" />
        </div>
      }
    >
      <OrdersHistoryPage />
    </Suspense>
  );
}
