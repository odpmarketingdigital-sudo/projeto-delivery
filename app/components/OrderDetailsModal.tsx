"use client";

import { useEffect, useState, type ChangeEvent } from "react";
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

export function OrderDetailsModal({
  order,
  shortNumber,
  establishmentName,
  isBusy,
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

  const [cancelMode, setCancelMode] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [printWidth, setPrintWidth] = useState<"58" | "80">("80");

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
      // Cancelamento exige motivo: abre o formulário em vez de aplicar direto.
      setCancelMode(true);
      setCancelReason("");
      setActionError(null);
      setActionMessage(null);
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
          className="relative flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-gray-700 bg-gray-900 shadow-2xl sm:max-h-[90vh] sm:rounded-2xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-gray-800 px-4 py-4 sm:px-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
                Pedido
              </p>
              <h2
                id="order-details-title"
                className="text-xl font-black tracking-tight text-white"
              >
                {shortNumber}
              </h2>
              <p className="mt-0.5 text-xs text-gray-400">
                {formatDateTime(order.created_at)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ${meta.badgeClass}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
                {meta.label}
              </span>
              <button
                type="button"
                onClick={onClose}
                disabled={isBusy}
                aria-label="Fechar"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-700 text-lg leading-none text-gray-400 transition hover:bg-gray-800 hover:text-white disabled:opacity-50"
              >
                ×
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <section className="rounded-xl border border-gray-800 bg-gray-800/30 p-3.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                  Cliente
                </h3>
                <p className="mt-2 font-semibold text-white">
                  {order.customer_name}
                </p>
                {order.customer_phone ? (
                  <a
                    href={phoneHref ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-block text-sm text-yellow-300 hover:underline"
                  >
                    {order.customer_phone}
                  </a>
                ) : (
                  <p className="mt-0.5 text-sm text-gray-500">Sem telefone</p>
                )}
                {order.notes && (
                  <p className="mt-2 whitespace-pre-wrap rounded-lg bg-gray-900/70 px-2.5 py-2 text-xs text-gray-300">
                    <span className="font-bold text-gray-200">
                      Observações:{" "}
                    </span>
                    {order.notes}
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-gray-800 bg-gray-800/30 p-3.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                  Entrega
                </h3>
                <span className="mt-2 inline-flex rounded-full bg-gray-700/60 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-200">
                  {deliveryType}
                </span>
                {address ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-300">
                    {address}
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">
                    Retirada no balcão do estabelecimento.
                  </p>
                )}
                {estimateLabel || estimatedAtLabel ? (
                  <div className="mt-2 rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-2.5 py-2">
                    <p className="text-xs font-semibold text-yellow-200">
                      Previsão:{" "}
                      <span className="font-bold">
                        {estimateLabel ?? "definida pela loja"}
                      </span>
                    </p>
                    {estimatedAtLabel && (
                      <p className="mt-0.5 text-[11px] text-gray-300">
                        Horário previsto: {estimatedAtLabel}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">
                    Previsão de entrega não informada.
                  </p>
                )}
              </section>
            </div>

            <section className="mt-5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                Itens do pedido
              </h3>
              <ul className="mt-2 divide-y divide-gray-800 rounded-xl border border-gray-800 bg-gray-800/20">
                {order.items.length === 0 ? (
                  <li className="px-3.5 py-3 text-sm text-gray-500">
                    Nenhum item registrado.
                  </li>
                ) : (
                  order.items.map((item, index) => (
                    <li
                      key={`${item.product_id ?? item.name}-${index}`}
                      className="px-3.5 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-100">
                            {item.quantity}× {item.name}
                          </p>
                          <p className="mt-0.5 text-xs text-gray-400">
                            {formatBRL(item.unit_price)} / unidade
                          </p>
                          {item.addons && item.addons.length > 0 && (
                            <ul className="mt-1.5 space-y-1">
                              {item.addons.map((addon, addonIndex) => (
                                <li
                                  key={`${addon.id}-${addonIndex}`}
                                  className="flex justify-between gap-3 text-xs text-gray-400"
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
                            <p className="mt-1.5 rounded-lg bg-yellow-400/10 px-2.5 py-1.5 text-xs text-yellow-200">
                              Obs.: {item.notes}
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 font-bold tabular-nums text-white">
                          {formatBRL(item.line_total)}
                        </span>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </section>

            <section className="mt-5 rounded-xl border border-gray-800 bg-gray-800/30 p-3.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                Resumo financeiro
              </h3>
              <dl className="mt-2 space-y-1.5 text-sm">
                <div className="flex items-center justify-between gap-3 text-gray-400">
                  <dt>Subtotal</dt>
                  <dd className="tabular-nums">{formatBRL(order.subtotal)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 text-gray-400">
                  <dt>Taxa de entrega</dt>
                  <dd className="tabular-nums">
                    {formatBRL(order.delivery_fee)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 text-gray-400">
                  <dt>Descontos</dt>
                  <dd className="tabular-nums">
                    {discount > 0 ? `- ${formatBRL(discount)}` : formatBRL(0)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-gray-700 pt-2 text-base font-black text-white">
                  <dt>Total</dt>
                  <dd className="tabular-nums">{formatBRL(order.total)}</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-800 pt-2 text-xs text-gray-400">
                <span>
                  Pagamento:{" "}
                  <span className="font-semibold text-gray-200">{payment}</span>
                </span>
                {order.change_for && order.change_for > 0 && (
                  <span>
                    Troco para:{" "}
                    <span className="font-semibold text-gray-200">
                      {formatBRL(order.change_for)}
                    </span>
                  </span>
                )}
              </div>
            </section>

            {order.status === "cancelado" && order.cancellation_reason && (
              <section className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 p-3.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-red-300">
                  Motivo do cancelamento
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-red-200">
                  {order.cancellation_reason}
                </p>
              </section>
            )}
          </div>

          <footer className="border-t border-gray-800 bg-gray-900/95 px-4 py-4 sm:px-6">
            {cancelMode && canCancel ? (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="cancel-reason"
                    className="mb-1.5 block text-sm font-semibold text-gray-200"
                  >
                    Motivo do cancelamento{" "}
                    <span className="text-red-400">*</span>
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
                    className="w-full resize-none rounded-xl border border-gray-700 bg-gray-950 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60 focus:ring-2 focus:ring-yellow-400/20"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Obrigatório — o cliente verá este motivo no acompanhamento
                    do pedido.
                  </p>
                </div>

                {actionError && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                  >
                    {actionError}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCancelMode(false);
                      setActionError(null);
                    }}
                    disabled={isBusy}
                    className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
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
              <div className="flex flex-col gap-3">
                {actionError && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                  >
                    {actionError}
                  </p>
                )}

                {actionMessage && (
                  <p
                    role="status"
                    className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"
                  >
                    {actionMessage}
                  </p>
                )}

                <div className="rounded-xl border border-gray-800 bg-gray-800/30 p-3.5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
                        Status do pedido
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {isCancelled
                          ? "Pedido cancelado — escolha Pendente ou Em Preparo para reativar."
                          : "Avance, volte ou pule para qualquer etapa."}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
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
                        className="rounded-lg border border-gray-700 px-3 py-2 text-xs font-bold text-gray-200 transition hover:border-yellow-400/50 hover:text-yellow-300 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ← Voltar
                      </button>
                      <select
                        aria-label="Alterar status do pedido"
                        value={order.status}
                        onChange={handleStatusSelect}
                        disabled={isBusy}
                        className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm font-semibold text-gray-100 outline-none transition focus:border-yellow-400/60 focus:ring-2 focus:ring-yellow-400/20 disabled:cursor-not-allowed disabled:opacity-60"
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
                      <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!nextStatus || isBusy}
                        title={
                          nextStatus
                            ? `Avançar para ${ORDER_STATUS_META[nextStatus].label}`
                            : undefined
                        }
                        className="rounded-lg border border-yellow-400/40 bg-yellow-400/10 px-3 py-2 text-xs font-bold text-yellow-200 transition hover:bg-yellow-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Avançar →
                      </button>
                    </div>

                    {!isCancelled && (
                      <div className="mt-3 rounded-xl border border-yellow-400/20 bg-yellow-400/5 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-bold uppercase tracking-wider text-yellow-300">
                            Previsão de entrega
                          </p>
                          {estimateLabel && (
                            <span className="rounded-full bg-yellow-400/15 px-2 py-0.5 text-[11px] font-bold text-yellow-200">
                              Atual: {estimateLabel}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {ESTIMATED_DELIVERY_OPTIONS.map((option) => {
                            const isActive =
                              estimateWindow?.min === option.min &&
                              estimateWindow?.max === option.max;
                            return (
                              <button
                                key={`${option.min}-${option.max}`}
                                type="button"
                                onClick={() =>
                                  void applyStatus(
                                    order.status,
                                    undefined,
                                    option
                                  )
                                }
                                disabled={isBusy || isActive}
                                aria-pressed={isActive}
                                className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold transition disabled:cursor-not-allowed ${
                                  isActive
                                    ? "border-yellow-400 bg-yellow-400 text-gray-950"
                                    : "border-gray-700 text-gray-200 hover:border-yellow-400/50 hover:text-yellow-200 disabled:opacity-50"
                                }`}
                              >
                                {formatEstimatedDeliveryWindowLabel(option)}
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-1.5 text-[11px] text-gray-500">
                          Ao escolher, a previsão e o horário previsto são
                          recalculados a partir de agora.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      htmlFor="print-width"
                      className="text-xs font-semibold uppercase tracking-wider text-gray-500"
                    >
                      Bobina
                    </label>
                    <select
                      id="print-width"
                      value={printWidth}
                      onChange={(event) =>
                        setPrintWidth(event.target.value as "58" | "80")
                      }
                      className="rounded-lg border border-gray-700 bg-gray-950 px-2.5 py-2 text-xs font-semibold text-gray-200 outline-none focus:border-yellow-400/60"
                    >
                      <option value="58">58 mm</option>
                      <option value="80">80 mm</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs font-bold text-gray-200 transition hover:border-yellow-400/50 hover:text-yellow-300"
                    >
                      <svg
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
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
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      disabled={isBusy}
                      className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Fechar
                    </button>
                    {canCancel ? (
                      <button
                        type="button"
                        onClick={() => {
                          setCancelMode(true);
                          setCancelReason("");
                          setActionError(null);
                          setActionMessage(null);
                        }}
                        disabled={isBusy}
                        className="rounded-xl border border-red-500/40 px-4 py-2.5 text-sm font-bold text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancelar Pedido
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void applyStatus("pendente")}
                        disabled={isBusy}
                        className="rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/20 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isBusy ? "Reativando..." : "Reativar como Pendente"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
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
