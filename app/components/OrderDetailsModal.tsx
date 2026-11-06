"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  // Alias obrigatório: o `KeyboardEvent` global (usado no listener de `window`)
  // continua sendo o do DOM, e não o sintético do React.
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { OrderStatus, PanelOrder } from "@/lib/types";
import {
  canCancelOrder,
  nextOrderStatus,
  ORDER_STATUS_META,
  ORDER_STATUS_OPTIONS,
  previousOrderStatus,
} from "@/lib/orderStatus";
import {
  ESTIMATED_DELIVERY_OPTIONS,
  formatEstimatedDeliveryWindowLabel,
  parseEstimatedDeliveryWindow,
  type EstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";

interface OrderDetailsModalProps {
  order: PanelOrder;
  shortNumber: string;
  establishmentName: string;
  isBusy: boolean;
  /**
   * true = abre já no formulário de motivo de cancelamento. Usado quando o
   * operador solta o card na coluna "Cancelados" do Kanban (o cancelamento
   * exige motivo na API).
   */
  initialCancelMode?: boolean;
  onClose: () => void;
  onUpdateStatus: (
    orderId: string,
    status: OrderStatus,
    cancellationReason?: string,
    estimate?: EstimatedDeliveryWindow
  ) => Promise<void>;
}

const PAYMENT_LABEL: Record<string, string> = {
  pix: "Pix",
  cartao: "Cartão na entrega",
  dinheiro: "Dinheiro",
};

function formatBRL(value: number): string {
  return `R$ ${Number(value).toFixed(2).replace(".", ",")}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} às ${time}`;
}

function deliveryTypeLabel(order: PanelOrder): "Entrega" | "Retirada" {
  const raw = order.delivery_type?.trim().toLowerCase();
  if (raw === "retirada" || raw === "pickup") return "Retirada";
  if (raw === "entrega" || raw === "delivery") return "Entrega";

  const address = order.customer_address;
  const hasAddress = Boolean(
    address &&
      (address.street?.trim() ||
        address.number?.trim() ||
        address.neighborhood?.trim())
  );
  return hasAddress ? "Entrega" : "Retirada";
}

function addressText(order: PanelOrder): string {
  const address = order.customer_address;
  if (!address) return "";
  const streetLine = [address.street?.trim(), address.number?.trim()]
    .filter(Boolean)
    .join(", ");
  const line = [
    streetLine,
    address.neighborhood?.trim(),
    address.complement?.trim(),
  ]
    .filter(Boolean)
    .join(" • ");
  const reference = address.reference?.trim();
  return reference ? `${line} (Ref.: ${reference})` : line;
}

function orderDiscount(order: PanelOrder): number {
  return Math.max(
    0,
    Number((order.subtotal + order.delivery_fee - order.total).toFixed(2))
  );
}

/** Normaliza o telefone para o link do WhatsApp (55 + DDD + número). */
function whatsappHref(phone: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits.startsWith("55") ? digits : `55${digits}`}`;
}

/** Cupom não fiscal — conteúdo impresso na bobina térmica. */
function ThermalReceipt({
  order,
  shortNumber,
  establishmentName,
}: {
  order: PanelOrder;
  shortNumber: string;
  establishmentName: string;
}) {
  const meta = ORDER_STATUS_META[order.status];
  const discount = orderDiscount(order);
  const payment = PAYMENT_LABEL[order.payment_method] ?? order.payment_method;
  const address = addressText(order);
  const deliveryType = deliveryTypeLabel(order);

  return (
    <div className="text-black">
      <div className="text-center">
        <p className="text-sm font-bold uppercase">{establishmentName}</p>
        <p className="text-[9pt]">CUPOM NÃO FISCAL</p>
      </div>
      <div className="my-1 border-t border-dashed border-black" />
      <p>
        <strong>{shortNumber}</strong> · {formatDateTime(order.created_at)}
      </p>
      <p>Status: {meta.label}</p>
      <p>Tipo: {deliveryType}</p>
      <div className="my-1 border-t border-dashed border-black" />
      <p>
        <strong>Cliente:</strong> {order.customer_name}
      </p>
      {order.customer_phone && <p>Tel: {order.customer_phone}</p>}
      {address && <p className="whitespace-pre-wrap">End: {address}</p>}
      {order.notes && (
        <p className="whitespace-pre-wrap">Obs: {order.notes}</p>
      )}
      <div className="my-1 border-t border-dashed border-black" />
      <p className="font-bold">ITENS</p>
      {order.items.map((item, index) => (
        <div key={`${item.product_id ?? item.name}-${index}`} className="mt-1">
          <div className="flex justify-between gap-2">
            <span>
              {item.quantity}x {item.name}
            </span>
            <span>{formatBRL(item.line_total)}</span>
          </div>
          <p className="text-[9pt]">UN: {formatBRL(item.unit_price)}</p>
          {item.addons?.map((addon, addonIndex) => (
            <div
              key={`${addon.id}-${addonIndex}`}
              className="flex justify-between gap-2 pl-2 text-[9pt]"
            >
              <span>+ {addon.name}</span>
              <span>{formatBRL(addon.price)}</span>
            </div>
          ))}
          {item.notes && (
            <p className="whitespace-pre-wrap pl-2 text-[9pt]">
              Obs: {item.notes}
            </p>
          )}
        </div>
      ))}
      <div className="my-1 border-t border-dashed border-black" />
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{formatBRL(order.subtotal)}</span>
      </div>
      <div className="flex justify-between">
        <span>Entrega</span>
        <span>{formatBRL(order.delivery_fee)}</span>
      </div>
      <div className="flex justify-between">
        <span>Desconto</span>
        <span>{discount > 0 ? `- ${formatBRL(discount)}` : formatBRL(0)}</span>
      </div>
      <div className="mt-1 flex justify-between border-t border-black pt-1 text-sm font-bold">
        <span>TOTAL</span>
        <span>{formatBRL(order.total)}</span>
      </div>
      <div className="my-1 border-t border-dashed border-black" />
      <p>Pagamento: {payment}</p>
      {order.change_for && order.change_for > 0 && (
        <p>Troco para: {formatBRL(order.change_for)}</p>
      )}
      {order.cancellation_reason && (
        <p className="whitespace-pre-wrap">
          <strong>Cancelado:</strong> {order.cancellation_reason}
        </p>
      )}
      <div className="my-1 border-t border-dashed border-black" />
      <p className="text-center">Obrigado pela preferência!</p>
    </div>
  );
}

type ModalTab = "detalhes" | "status" | "acoes";

/**
 * Abas do modal — nesta ordem. A lista é uma constante (e não um array inline
 * no render) porque a navegação por teclado (`←`/`→`/`Home`/`End`) e o par
 * `aria-controls`/`id` dos painéis dependem de índices estáveis.
 */
const MODAL_TABS: ReadonlyArray<{ id: ModalTab; label: string }> = [
  { id: "detalhes", label: "Detalhes" },
  { id: "status", label: "Status e Tempo" },
  { id: "acoes", label: "Impressão e Ações" },
];

/** Ícone decorativo da aba (o rótulo já descreve a seção). */
function TabIcon({
  tab,
  className = "",
}: {
  tab: ModalTab;
  /** Classes extras — o painel usa para esconder o ícone no mobile. */
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={`h-4 w-4 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      {tab === "detalhes" && (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.25 6.75h12M8.25 12h12M8.25 17.25h12M3.75 6.75h.008v.008H3.75V6.75Zm0 5.25h.008v.008H3.75V12Zm0 5.25h.008v.008H3.75v-.008Z"
        />
      )}
      {tab === "status" && (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        />
      )}
      {tab === "acoes" && (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Z"
        />
      )}
    </svg>
  );
}

/**
 * Cartão de seção usado dentro das abas: título curto, descrição opcional e
 * respiro interno generoso — o volume de informação fica distribuído em blocos
 * em vez de um único bloco denso.
 */
function SectionCard({
  title,
  description,
  tone = "neutral",
  children,
}: {
  title: string;
  description?: string;
  tone?: "neutral" | "warning" | "danger";
  children: ReactNode;
}) {
  const cardClass = {
    neutral: "border-slate-200 bg-slate-50",
    warning: "border-amber-300 bg-amber-50/70",
    danger: "border-red-200 bg-red-50",
  }[tone];
  const titleClass = {
    neutral: "text-slate-500",
    warning: "text-amber-700",
    danger: "text-red-600",
  }[tone];

  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${cardClass}`}>
      <h3
        className={`text-xs font-bold uppercase tracking-wider ${titleClass}`}
      >
        {title}
      </h3>
      {description && (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
          {description}
        </p>
      )}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

export function OrderDetailsModal({
  order,
  shortNumber,
  establishmentName,
  isBusy,
  initialCancelMode = false,
  onClose,
  onUpdateStatus,
}: OrderDetailsModalProps) {
  const meta = ORDER_STATUS_META[order.status];
  const previousStatus = previousOrderStatus(order.status);
  const nextStatus = nextOrderStatus(order.status);
  const isCancelled = order.status === "cancelado";
  const canCancel = canCancelOrder(order.status);
  const discount = orderDiscount(order);
  const deliveryType = deliveryTypeLabel(order);
  const address = addressText(order);
  const payment = PAYMENT_LABEL[order.payment_method] ?? order.payment_method;
  const phoneHref = whatsappHref(order.customer_phone);
  const estimateWindow = parseEstimatedDeliveryWindow(
    order.estimated_delivery_time
  );
  const estimateLabel = estimateWindow
    ? formatEstimatedDeliveryWindowLabel(estimateWindow)
    : order.estimated_delivery_time;
  const estimatedAtLabel = order.estimated_delivery_at
    ? formatDateTime(order.estimated_delivery_at)
    : null;

  /**
   * Aba inicial: quando o operador solta o card na coluna "Cancelados" o modal
   * já abre em "Impressão e Ações", onde fica o formulário de motivo.
   */
  const [activeTab, setActiveTab] = useState<ModalTab>(
    initialCancelMode ? "acoes" : "detalhes"
  );
  const [cancelMode, setCancelMode] = useState(initialCancelMode);
  const [cancelReason, setCancelReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [printWidth, setPrintWidth] = useState<"58" | "80">("80");

  const contentRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isBusy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isBusy, onClose]);

  /** Troca de aba, voltando o conteúdo ao topo (as abas têm alturas distintas). */
  const changeTab = (tab: ModalTab) => {
    setActiveTab(tab);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  /** Navegação por teclado entre abas: setas, Home e End (padrão ARIA). */
  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const lastIndex = MODAL_TABS.length - 1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = index === lastIndex ? 0 : index + 1;
    } else if (event.key === "ArrowLeft") {
      nextIndex = index === 0 ? lastIndex : index - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    changeTab(MODAL_TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  /**
   * Aplica qualquer transição válida sem fechar o modal, para o operador
   * poder avançar, voltar ou pular etapas na mesma sessão.
   */
  const applyStatus = async (
    status: OrderStatus,
    cancellationReason?: string,
    estimate?: EstimatedDeliveryWindow
  ) => {
    if (status === order.status && !estimate) return;
    setActionError(null);
    setActionMessage(null);
    try {
      await onUpdateStatus(order.id, status, cancellationReason, estimate);
      setCancelMode(false);
      setCancelReason("");
      setActionMessage(
        estimate
          ? `Previsão de entrega atualizada para ${formatEstimatedDeliveryWindowLabel(estimate)}.`
          : `Status atualizado para ${ORDER_STATUS_META[status].label}.`
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Falha ao atualizar o pedido."
      );
    }
  };

  const handleConfirm = () => {
    if (nextStatus) void applyStatus(nextStatus);
  };

  const handleStatusSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const status = event.target.value as OrderStatus;
    if (status === order.status) return;
    if (status === "cancelado") {
      // Cancelamento exige motivo: leva o operador ao formulário da aba de ações
      // em vez de aplicar direto.
      setCancelMode(true);
      setCancelReason("");
      setActionError(null);
      setActionMessage(null);
      changeTab("acoes");
      return;
    }
    setCancelMode(false);
    void applyStatus(status);
  };

  const handleCancel = async () => {
    const reason = cancelReason.trim();
    if (reason.length < 3) {
      setActionError("Informe o motivo do cancelamento (mínimo 3 caracteres).");
      return;
    }
    await applyStatus("cancelado", reason);
  };

  /** Abre o formulário de motivo (rodapé ou aba "Impressão e Ações"). */
  const startCancellation = () => {
    setCancelMode(true);
    setCancelReason("");
    setActionError(null);
    setActionMessage(null);
    changeTab("acoes");
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
        <button
          type="button"
          aria-label="Fechar detalhes do pedido"
          onClick={onClose}
          disabled={isBusy}
          className="absolute inset-0 cursor-default bg-black/75 backdrop-blur-sm disabled:cursor-not-allowed"
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="order-details-title"
          className="relative flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-slate-300 bg-white shadow-2xl sm:max-h-[90vh] sm:rounded-2xl"
        >
          {/* Cabeçalho: número do pedido, status atual e horário de criação */}
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-5 sm:px-7">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                Pedido
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h2
                  id="order-details-title"
                  className="text-2xl font-black leading-none tracking-tight text-slate-900"
                >
                  {shortNumber}
                </h2>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${meta.badgeClass}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
                  {meta.label}
                </span>
              </div>
              <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-600">
                <span className="font-semibold text-slate-800">Criado em</span>
                <span>{formatDateTime(order.created_at)}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isBusy}
              aria-label="Fechar"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-300 text-xl leading-none text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
            >
              ×
            </button>
          </header>

          {/* Navegação por abas */}
          <div
            role="tablist"
            aria-label="Seções do pedido"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-3 sm:px-5"
          >
            {MODAL_TABS.map((tab, index) => {
              const isActive = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`order-tab-${tab.id}`}
                  aria-selected={isActive}
                  aria-controls={`order-panel-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => changeTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  className={`relative inline-flex shrink-0 items-center gap-2 px-3 py-3.5 text-[11px] font-bold uppercase tracking-wider transition sm:px-4 ${
                    isActive
                      ? "text-slate-900"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  <TabIcon tab={tab.id} className="hidden sm:block" />
                  {tab.label}
                  <span
                    aria-hidden="true"
                    className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full transition ${
                      isActive ? "bg-amber-500" : "bg-transparent"
                    }`}
                  />
                </button>
              );
            })}
          </div>

          {/* Conteúdo da aba ativa */}
          <div
            ref={contentRef}
            className="flex-1 overflow-y-auto bg-white px-5 py-5 sm:px-7 sm:py-6"
          >
            {(actionError || actionMessage) && (
              <div className="mb-5 space-y-2">
                {actionError && (
                  <p
                    role="alert"
                    className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-600"
                  >
                    {actionError}
                  </p>
                )}
                {actionMessage && (
                  <p
                    role="status"
                    className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700"
                  >
                    {actionMessage}
                  </p>
                )}
              </div>
            )}

            {activeTab === "detalhes" && (
              <div
                role="tabpanel"
                id="order-panel-detalhes"
                aria-labelledby="order-tab-detalhes"
                className="space-y-5 sm:space-y-6"
              >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
                  <SectionCard title="Cliente">
                    <p className="text-base font-semibold text-slate-900">
                      {order.customer_name}
                    </p>
                    {order.customer_phone ? (
                      <a
                        href={phoneHref ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-sm font-medium text-amber-600 hover:underline"
                      >
                        {order.customer_phone}
                      </a>
                    ) : (
                      <p className="mt-1 text-sm text-slate-500">Sem telefone</p>
                    )}
                    {order.notes && (
                      <p className="mt-3 whitespace-pre-wrap rounded-xl bg-white px-3.5 py-2.5 text-xs leading-relaxed text-slate-700 ring-1 ring-slate-200">
                        <span className="font-bold text-slate-800">
                          Observações:{" "}
                        </span>
                        {order.notes}
                      </p>
                    )}
                  </SectionCard>

                  <SectionCard title="Entrega">
                    <span className="inline-flex rounded-full bg-slate-200 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-800">
                      {deliveryType}
                    </span>
                    {address ? (
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                        {address}
                      </p>
                    ) : (
                      <p className="mt-3 text-sm leading-relaxed text-slate-500">
                        Retirada no balcão do estabelecimento.
                      </p>
                    )}
                  </SectionCard>
                </div>

                <section>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      Itens do pedido
                    </h3>
                    <span className="text-xs font-semibold text-slate-500">
                      {order.items.length}{" "}
                      {order.items.length === 1 ? "item" : "itens"}
                    </span>
                  </div>
                  <ul className="mt-2.5 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
                    {order.items.length === 0 ? (
                      <li className="px-4 py-3.5 text-sm text-slate-500 sm:px-5">
                        Nenhum item registrado.
                      </li>
                    ) : (
                      order.items.map((item, index) => (
                        <li
                          key={`${item.product_id ?? item.name}-${index}`}
                          className="px-4 py-3.5 sm:px-5"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900">
                                {item.quantity}× {item.name}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-600">
                                {formatBRL(item.unit_price)} / unidade
                              </p>
                              {item.addons && item.addons.length > 0 && (
                                <ul className="mt-2 space-y-1">
                                  {item.addons.map((addon, addonIndex) => (
                                    <li
                                      key={`${addon.id}-${addonIndex}`}
                                      className="flex justify-between gap-3 text-xs text-slate-600"
                                    >
                                      <span>+ {addon.name}</span>
                                      <span className="tabular-nums">
                                        {formatBRL(addon.price)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {item.notes && (
                                <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
                                  Obs.: {item.notes}
                                </p>
                              )}
                            </div>
                            <span className="shrink-0 font-bold tabular-nums text-slate-900">
                              {formatBRL(item.line_total)}
                            </span>
                          </div>
                        </li>
                      ))
                    )}
                  </ul>
                </section>

                <SectionCard title="Resumo financeiro">
                  <dl className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3 text-slate-600">
                      <dt>Subtotal</dt>
                      <dd className="tabular-nums">
                        {formatBRL(order.subtotal)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-slate-600">
                      <dt>Taxa de entrega</dt>
                      <dd className="tabular-nums">
                        {formatBRL(order.delivery_fee)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-slate-600">
                      <dt>Descontos</dt>
                      <dd className="tabular-nums">
                        {discount > 0 ? `- ${formatBRL(discount)}` : formatBRL(0)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t border-slate-300 pt-2.5 text-base font-black text-slate-900">
                      <dt>Total</dt>
                      <dd className="tabular-nums">{formatBRL(order.total)}</dd>
                    </div>
                  </dl>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-xs text-slate-600">
                    <span>
                      Pagamento:{" "}
                      <span className="font-semibold text-slate-800">
                        {payment}
                      </span>
                    </span>
                    {order.change_for && order.change_for > 0 && (
                      <span>
                        Troco para:{" "}
                        <span className="font-semibold text-slate-800">
                          {formatBRL(order.change_for)}
                        </span>
                      </span>
                    )}
                  </div>
                </SectionCard>
              </div>
            )}

            {activeTab === "status" && (
              <div
                role="tabpanel"
                id="order-panel-status"
                aria-labelledby="order-tab-status"
                className="space-y-5 sm:space-y-6"
              >
                <SectionCard
                  title="Status do pedido"
                  description={
                    isCancelled
                      ? "Pedido cancelado — escolha Pendente ou Em Preparo para reativar."
                      : "Avance, volte ou pule para qualquer etapa do fluxo."
                  }
                >
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${meta.badgeClass}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`}
                        />
                        {meta.label}
                      </span>
                      {nextStatus && (
                        <span className="text-xs text-slate-600">
                          Próxima etapa:{" "}
                          <span className="font-semibold text-slate-800">
                            {ORDER_STATUS_META[nextStatus].label}
                          </span>
                        </span>
                      )}
                    </div>

                    <div>
                      <label
                        htmlFor="order-status-select"
                        className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500"
                      >
                        Alterar status
                      </label>
                      <select
                        id="order-status-select"
                        value={order.status}
                        onChange={handleStatusSelect}
                        disabled={isBusy}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-yellow-400/20 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {ORDER_STATUS_OPTIONS.map((status) => (
                          <option
                            key={status}
                            value={status}
                            disabled={status === order.status}
                          >
                            {ORDER_STATUS_META[status].label}
                            {status === order.status ? " (atual)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          if (previousStatus) void applyStatus(previousStatus);
                        }}
                        disabled={!previousStatus || isBusy}
                        title={
                          previousStatus
                            ? `Voltar para ${ORDER_STATUS_META[previousStatus].label}`
                            : undefined
                        }
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-bold text-slate-800 transition hover:border-amber-300 hover:text-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ← Voltar
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!nextStatus || isBusy}
                        title={
                          nextStatus
                            ? `Avançar para ${ORDER_STATUS_META[nextStatus].label}`
                            : undefined
                        }
                        className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs font-bold text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Avançar →
                      </button>
                    </div>
                  </div>
                </SectionCard>

                {!isCancelled && (
                  <SectionCard
                    title="Previsão de entrega"
                    tone="warning"
                    description="Ao escolher uma janela, a previsão e o horário previsto são recalculados a partir de agora."
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-700">
                        {estimateLabel
                          ? `Atual: ${estimateLabel}`
                          : "Sem previsão definida"}
                      </span>
                      {estimatedAtLabel && (
                        <span className="text-[11px] text-slate-600">
                          Horário previsto:{" "}
                          <span className="font-semibold text-slate-800">
                            {estimatedAtLabel}
                          </span>
                        </span>
                      )}
                    </div>

                    <div className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                      {ESTIMATED_DELIVERY_OPTIONS.map((option) => {
                        const isActive =
                          estimateWindow?.min === option.min &&
                          estimateWindow?.max === option.max;
                        return (
                          <button
                            key={`${option.min}-${option.max}`}
                            type="button"
                            onClick={() =>
                              void applyStatus(order.status, undefined, option)
                            }
                            disabled={isBusy || isActive}
                            aria-pressed={isActive}
                            className={`rounded-xl border px-2.5 py-2.5 text-xs font-bold transition disabled:cursor-not-allowed ${
                              isActive
                                ? "border-amber-400 bg-yellow-400 text-slate-950"
                                : "border-slate-300 bg-white text-slate-800 hover:border-amber-300 hover:text-amber-700 disabled:opacity-50"
                            }`}
                          >
                            {formatEstimatedDeliveryWindowLabel(option)}
                          </button>
                        );
                      })}
                    </div>
                  </SectionCard>
                )}
              </div>
            )}

            {activeTab === "acoes" && (
              <div
                role="tabpanel"
                id="order-panel-acoes"
                aria-labelledby="order-tab-acoes"
                className="space-y-5 sm:space-y-6"
              >
                <SectionCard
                  title="Impressão do cupom"
                  description="O cupom térmico é o único conteúdo enviado para a impressora — o resto do painel não é impresso."
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      id="print-width-label"
                      className="text-xs font-bold uppercase tracking-wider text-slate-500"
                    >
                      Bobina
                    </span>
                    <div
                      role="group"
                      aria-labelledby="print-width-label"
                      className="inline-flex rounded-xl border border-slate-300 bg-white p-1"
                    >
                      {(["58", "80"] as const).map((width) => {
                        const isActive = printWidth === width;
                        return (
                          <button
                            key={width}
                            type="button"
                            onClick={() => setPrintWidth(width)}
                            aria-pressed={isActive}
                            className={`rounded-lg px-3.5 py-2 text-xs font-bold transition ${
                              isActive
                                ? "bg-yellow-400 text-slate-950 shadow-sm"
                                : "text-slate-700 hover:bg-slate-100"
                            }`}
                          >
                            {width} mm
                          </button>
                        );
                      })}
                    </div>
                    <span className="text-xs text-slate-600">
                      Selecionada:{" "}
                      <span className="font-semibold text-slate-800">
                        {printWidth} mm
                      </span>
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/20 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Z"
                      />
                    </svg>
                    Imprimir cupom
                  </button>
                </SectionCard>

                <SectionCard
                  title="Cancelamento"
                  tone={isCancelled ? "danger" : "neutral"}
                  description={
                    isCancelled
                      ? undefined
                      : "O motivo é obrigatório e fica visível para o cliente no acompanhamento do pedido."
                  }
                >
                  {isCancelled ? (
                    <div className="space-y-3">
                      {order.cancellation_reason ? (
                        <p className="whitespace-pre-wrap rounded-xl bg-white px-3.5 py-3 text-sm leading-relaxed text-red-700 ring-1 ring-red-200">
                          {order.cancellation_reason}
                        </p>
                      ) : (
                        <p className="text-sm text-red-700">
                          Pedido cancelado sem motivo registrado.
                        </p>
                      )}
                      <p className="text-xs leading-relaxed text-slate-600">
                        Para reabrir, use{" "}
                        <span className="font-semibold text-slate-800">
                          “Reativar como Pendente”
                        </span>{" "}
                        no rodapé do modal.
                      </p>
                    </div>
                  ) : cancelMode ? (
                    <div className="space-y-3.5">
                      <div>
                        <label
                          htmlFor="cancel-reason"
                          className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500"
                        >
                          Motivo do cancelamento{" "}
                          <span className="text-red-600">*</span>
                        </label>
                        <textarea
                          id="cancel-reason"
                          rows={3}
                          autoFocus
                          value={cancelReason}
                          onChange={(event) => {
                            setCancelReason(event.target.value);
                            setActionError(null);
                          }}
                          placeholder="Ex.: cliente solicitou o cancelamento / item indisponível."
                          className="w-full resize-none rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-gray-500 outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-yellow-400/20"
                        />
                        <p className="mt-1.5 text-xs text-slate-500">
                          O cliente verá este motivo no acompanhamento do
                          pedido.
                        </p>
                      </div>
                      <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            setCancelMode(false);
                            setActionError(null);
                          }}
                          disabled={isBusy}
                          className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Voltar
                        </button>
                        <button
                          type="button"
                          onClick={handleCancel}
                          disabled={isBusy || cancelReason.trim().length < 3}
                          className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isBusy ? "Cancelando..." : "Confirmar cancelamento"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm leading-relaxed text-slate-600">
                        O pedido é marcado como cancelado imediatamente. Depois
                        disso ainda pode ser reativado como Pendente.
                      </p>
                      <button
                        type="button"
                        onClick={startCancellation}
                        disabled={isBusy}
                        className="rounded-xl border border-red-300 bg-white px-4 py-2.5 text-sm font-bold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancelar este pedido
                      </button>
                    </div>
                  )}
                </SectionCard>
              </div>
            )}
          </div>

          {/* Rodapé fixo: somente as ações essenciais */}
          <footer className="shrink-0 border-t border-slate-200 bg-white px-5 py-4 sm:px-7">
            <div className="grid grid-cols-1 gap-2.5 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/20 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Z"
                  />
                </svg>
                Imprimir
              </button>

              <button
                type="button"
                onClick={onClose}
                disabled={isBusy}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Fechar
              </button>

              {canCancel ? (
                <button
                  type="button"
                  onClick={startCancellation}
                  disabled={isBusy}
                  className="rounded-xl border border-red-300 px-4 py-2.5 text-sm font-bold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancelar Pedido
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void applyStatus("pendente")}
                  disabled={isBusy}
                  className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/20 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBusy ? "Reativando..." : "Reativar como Pendente"}
                </button>
              )}
            </div>
          </footer>
        </div>
      </div>

      {typeof document !== "undefined" &&
        createPortal(
          <div className="thermal-print-root">
            <div className={`thermal-receipt thermal-receipt--${printWidth}`}>
              <ThermalReceipt
                order={order}
                shortNumber={shortNumber}
                establishmentName={establishmentName}
              />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
