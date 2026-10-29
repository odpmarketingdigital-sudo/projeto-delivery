"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/context/CartContext";
import { formatCep, parseCep, type DeliveryQuote } from "@/lib/delivery";
import {
  buildCatalogWhatsAppUrl,
  isCartItemPriceOnRequest,
  isDirectWhatsAppCheckoutEnabled,
} from "@/lib/catalogOrder";
import type { StorefrontInfo } from "@/lib/types";

/** Resposta de `POST /api/delivery-quote` usada na sacola. */
interface DeliveryQuotePreview extends DeliveryQuote {
  cep: string | null;
  address: {
    street: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
  } | null;
  warnings: string[];
}

interface DeliveryQuoteResponse {
  error?: string;
  /** Distância também exposta na raiz da resposta (float ou `null`). */
  distance_km?: number | null;
  quote?: DeliveryQuotePreview;
}

/** Cotação vinculada à chave loja+CEP que a originou. */
interface DeliveryQuoteState {
  key: string;
  quote: DeliveryQuotePreview | null;
  error: string | null;
  loading: boolean;
}

interface CartDrawerProps {
  open: boolean;
  onClose: () => void;
  slug?: string;
  establishment: StorefrontInfo | null;
  storeClosed?: boolean;
  nextOpeningLabel?: string | null;
}

const formatBRL = (value: number) =>
  `R$ ${value.toFixed(2).replace(".", ",")}`;

const formatKm = (value: number) => value.toFixed(1).replace(".", ",");

/**
 * Sacola lateral do cardápio público.
 *
 * Calcula/valida o frete ANTES do checkout:
 *  - loja com taxa fixa: exibe a taxa da loja no resumo;
 *  - loja por distância: pede o CEP, consulta `/api/delivery-quote`, mostra a
 *    distância e o valor calculado e guarda o CEP no contexto do carrinho;
 *  - fora do raio: mostra o aviso em vermelho e bloqueia o avanço.
 */
export function CartDrawer({
  open,
  onClose,
  slug,
  establishment,
  storeClosed = false,
  nextOpeningLabel,
}: CartDrawerProps) {
  const router = useRouter();
  const {
    items,
    removeLine,
    setLineQuantity,
    deliveryCep,
    setDeliveryCep,
  } = useCart();

  const [cepInput, setCepInput] = useState(() => formatCep(deliveryCep));
  const [lastSyncedCep, setLastSyncedCep] = useState(deliveryCep);
  // Falha ao montar o link do WhatsApp (ex.: loja sem telefone cadastrado).
  const [directError, setDirectError] = useState<string | null>(null);

  // O contexto pode hidratar depois da primeira renderização (localStorage).
  // Nesse caso, preenche o campo sem sobrescrever um valor já digitado.
  if (deliveryCep && deliveryCep !== lastSyncedCep) {
    setLastSyncedCep(deliveryCep);
    setCepInput(formatCep(deliveryCep));
  }

  const establishmentId = establishment?.id ?? null;
  const deliveryType = establishment?.delivery_type ?? "fixed";
  const maxRadius = establishment?.max_delivery_radius_km ?? null;
  const needsCep = Boolean(
    establishment &&
      (deliveryType === "distance" || maxRadius != null)
  );
  const fixedFee = Number(establishment?.delivery_fee ?? 0) || 0;

  const cartItems = useMemo(
    () =>
      establishmentId
        ? items.filter((item) => item.establishmentId === establishmentId)
        : items,
    [items, establishmentId]
  );

  const itemCount = cartItems.reduce(
    (acc, item) => acc + item.quantidade,
    0
  );
  const subtotal = cartItems.reduce((acc, item) => {
    if (typeof item.itemTotalPrice === "number") {
      return acc + item.itemTotalPrice;
    }
    const unit =
      item.unitPrice ??
      (item.basePrice ?? 0) +
        (item.selectedOptions ?? []).reduce(
          (sum, option) => sum + option.price,
          0
        );
    return acc + unit * item.quantidade;
  }, 0);

  const cepDigits = parseCep(cepInput);
  const quoteKey =
    establishmentId && needsCep && cepDigits
      ? `${establishmentId}:${cepDigits}`
      : null;

  const [quoteState, setQuoteState] = useState<DeliveryQuoteState | null>(null);
  // Incrementado pelo botão "Calcular" para refazer a consulta imediatamente.
  const [quoteAttempt, setQuoteAttempt] = useState(0);

  useEffect(() => {
    if (!open || !quoteKey || !establishmentId || !cepDigits) return;

    let cancelled = false;

    const timer = window.setTimeout(async () => {
      setQuoteState({
        key: quoteKey,
        quote: null,
        error: null,
        loading: true,
      });
      try {
        const res = await fetch("/api/delivery-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            establishment_id: establishmentId,
            cep: cepDigits,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as DeliveryQuoteResponse;
        if (cancelled) return;
        if (!res.ok || !data.quote) {
          throw new Error(data.error ?? "Não foi possível calcular a entrega.");
        }
        setQuoteState({
          key: quoteKey,
          quote: {
            ...data.quote,
            distance_km: data.distance_km ?? data.quote.distance_km ?? null,
          },
          error: null,
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        setQuoteState({
          key: quoteKey,
          quote: null,
          error:
            err instanceof Error ? err.message : "Erro ao calcular a entrega.",
          loading: false,
        });
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, quoteKey, quoteAttempt, establishmentId, cepDigits]);

  const currentQuoteState =
    quoteState && quoteState.key === quoteKey ? quoteState : null;
  const quote = currentQuoteState?.quote ?? null;
  const quoteError = currentQuoteState?.error ?? null;
  const isQuoting =
    open &&
    quoteKey != null &&
    (currentQuoteState == null || currentQuoteState.loading);

  const deliveryFee =
    establishment == null
      ? null
      : deliveryType === "distance"
        ? quote?.fee ?? null
        : fixedFee;

  const deliveryDistanceKm =
    quote?.distance_km != null && quote.distance_km > 0
      ? quote.distance_km
      : null;
  const deliveryOutOfRange = quote?.within_radius === false;
  const deliveryOutOfRangeMessage = deliveryOutOfRange
    ? deliveryDistanceKm != null
      ? `Não entregamos nesta localização. Endereço a ${formatKm(
          deliveryDistanceKm
        )} km do estabelecimento` +
        (quote?.max_delivery_radius_km != null
          ? ` (limite máximo: ${formatKm(quote.max_delivery_radius_km)} km).`
          : ".")
      : "Não entregamos nesta localização: endereço fora da área de entrega."
    : null;

  const quoteWarnings = quote?.warnings ?? [];
  const quoteReady =
    !needsCep || (quote != null && !quoteError && !isQuoting);
  const canCheckout =
    establishment != null &&
    itemCount > 0 &&
    !storeClosed &&
    quoteReady &&
    !deliveryOutOfRange;

  // Modo catálogo: a loja recebe o pedido/orçamento direto no WhatsApp e o
  // cliente não passa pelo checkout. Ausência do campo = fluxo tradicional.
  const directWhatsAppCheckout = isDirectWhatsAppCheckoutEnabled(establishment);
  // Pelo menos um item "Sob Consulta": esconde os totais (o valor é combinado).
  const hasPriceOnRequest = cartItems.some((item) =>
    isCartItemPriceOnRequest(item)
  );
  // No envio direto o CEP/frete não bloqueia o pedido — só itens e loja aberta.
  const canSendDirect =
    establishment != null && itemCount > 0 && !storeClosed;
  const canSubmit = directWhatsAppCheckout ? canSendDirect : canCheckout;

  const feeLabel =
    deliveryDistanceKm != null
      ? `Entrega (${formatKm(deliveryDistanceKm)} km)`
      : "Entrega";

  const feeDisplay =
    deliveryFee != null
      ? formatBRL(deliveryFee)
      : isQuoting
        ? "Calculando..."
        : "A calcular";

  const totalDisplay =
    deliveryFee != null
      ? formatBRL(subtotal + deliveryFee)
      : "A calcular";

  let checkoutHint: string | null = null;
  if (!establishment) {
    checkoutHint = "Carregando informações da loja...";
  } else if (deliveryOutOfRange) {
    checkoutHint =
      "Altere o CEP ou, se preferir, combine a retirada no local com a loja.";
  } else if (needsCep && !cepDigits) {
    checkoutHint =
      deliveryType === "distance"
        ? "Informe seu CEP para calcular a entrega."
        : "Informe seu CEP para validar a área de entrega.";
  } else if (isQuoting) {
    checkoutHint = "Calculando o frete...";
  } else if (quoteError) {
    checkoutHint = quoteError;
  } else if (needsCep && !quote) {
    checkoutHint = "Calcule o frete para continuar.";
  }

  const whatsappDigits = (establishment?.whatsapp || establishment?.phone || "")
    .replace(/\D/g, "");
  const pickupContactHref = whatsappDigits
    ? `https://wa.me/${whatsappDigits}?text=${encodeURIComponent(
        "Olá! Meu endereço está fora da área de entrega. Gostaria de saber sobre a retirada no local."
      )}`
    : null;

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  const handleCepChange = (value: string) => {
    const formatted = formatCep(value);
    setCepInput(formatted);
    setDeliveryCep(parseCep(formatted) ?? "");
  };

  const handleCalculate = () => {
    if (!cepDigits || !quoteKey) return;
    setDeliveryCep(cepDigits);
    setQuoteState({ key: quoteKey, quote: null, error: null, loading: true });
    setQuoteAttempt((attempt) => attempt + 1);
  };

  const handleCheckout = () => {
    if (!canCheckout) return;
    onClose();
    router.push(slug ? `/${slug}/checkout` : "/checkout");
  };

  /**
   * Modo catálogo: monta o pedido/orçamento e abre o WhatsApp da loja. Nada é
   * gravado em `orders` — o pedido existe apenas na conversa.
   */
  const handleSendDirect = () => {
    if (!canSendDirect) return;

    const url = buildCatalogWhatsAppUrl(establishment, {
      items: cartItems.map((item) => {
        const priceOnRequest = isCartItemPriceOnRequest(item);
        return {
          name: item.productName ?? "Item",
          quantity: item.quantidade,
          unit_price: priceOnRequest ? null : item.unitPrice,
          line_total: priceOnRequest ? null : item.itemTotalPrice,
          price_on_request: priceOnRequest,
          addons: (item.selectedOptions ?? []).map((option) => ({
            name: option.name,
            price: priceOnRequest ? null : option.price,
          })),
          notes: item.notes ?? null,
        };
      }),
      deliveryCep: cepDigits ?? null,
    });

    if (!url) {
      setDirectError(
        "Não foi possível abrir o WhatsApp. Confira o número cadastrado em Configurações da loja."
      );
      return;
    }

    setDirectError(null);
    window.open(url, "_blank", "noopener,noreferrer");
    onClose();
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cart-drawer-title"
      className="fixed inset-0 z-[70] flex justify-end"
    >
      <button
        type="button"
        aria-label="Fechar sacola"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />

      <aside className="relative flex h-full w-full max-w-md flex-col bg-white shadow-2xl dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-4 dark:border-gray-700">
          <div>
            <h2
              id="cart-drawer-title"
              className="text-lg font-bold text-gray-900 dark:text-white"
            >
              Sua sacola
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {itemCount} {itemCount === 1 ? "item" : "itens"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar sacola"
            className="flex h-9 w-9 items-center justify-center rounded-full text-xl font-bold text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {cartItems.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center dark:border-gray-700">
              <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                Sua sacola está vazia.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-3 text-sm font-bold text-gray-900 underline dark:text-yellow-400"
              >
                Voltar ao cardápio
              </button>
            </div>
          ) : (
            <ul className="space-y-3">
              {cartItems.map((item) => {
                const unit =
                  item.unitPrice ??
                  (item.basePrice ?? 0) +
                    (item.selectedOptions ?? []).reduce(
                      (sum, option) => sum + option.price,
                      0
                    );
                const lineTotal =
                  typeof item.itemTotalPrice === "number"
                    ? item.itemTotalPrice
                    : unit * item.quantidade;
                return (
                  <li
                    key={item.id}
                    className="rounded-2xl border border-gray-200 p-3 dark:border-gray-700"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold leading-tight text-gray-900 dark:text-white">
                          {item.productName ?? "Item"}
                        </p>
                        {(item.selectedOptions ?? []).length > 0 && (
                          <p className="mt-0.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                            {(item.selectedOptions ?? [])
                              .map((option) => option.name)
                              .join(" · ")}
                          </p>
                        )}
                        {item.notes && (
                          <p className="mt-0.5 text-xs italic text-gray-400">
                            Obs.: {item.notes}
                          </p>
                        )}
                      </div>
                      {isCartItemPriceOnRequest(item) ? (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                          Sob consulta
                        </span>
                      ) : (
                        <span className="shrink-0 text-sm font-bold tabular-nums text-gray-900 dark:text-white">
                          {formatBRL(lineTotal)}
                        </span>
                      )}
                    </div>

                    <div className="mt-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label={`Diminuir a quantidade de ${
                            item.productName ?? "item"
                          }`}
                          disabled={item.quantidade <= 1}
                          onClick={() =>
                            setLineQuantity(item.id, item.quantidade - 1)
                          }
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-base font-bold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                        >
                          −
                        </button>
                        <span
                          aria-live="polite"
                          className="min-w-6 text-center text-sm font-bold tabular-nums text-gray-900 dark:text-white"
                        >
                          {item.quantidade}
                        </span>
                        <button
                          type="button"
                          aria-label={`Aumentar a quantidade de ${
                            item.productName ?? "item"
                          }`}
                          disabled={item.quantidade >= 99}
                          onClick={() =>
                            setLineQuantity(item.id, item.quantidade + 1)
                          }
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-900 text-base font-bold text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(item.id)}
                        className="text-xs font-semibold text-gray-500 underline transition hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
                      >
                        Remover
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {needsCep && (
            <section className="mt-5 rounded-2xl border border-gray-200 bg-gray-50/70 p-4 dark:border-gray-700 dark:bg-gray-800/40">
              <label
                htmlFor="cart-delivery-cep"
                className="block text-sm font-bold text-gray-900 dark:text-white"
              >
                {deliveryType === "distance"
                  ? "Digite seu CEP para calcular a entrega"
                  : "Digite seu CEP para validar a entrega"}
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="cart-delivery-cep"
                  type="text"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="00000-000"
                  maxLength={9}
                  value={cepInput}
                  onChange={(event) => handleCepChange(event.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm tabular-nums text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/20 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={handleCalculate}
                  disabled={!cepDigits || isQuoting}
                  className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-400 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
                >
                  {isQuoting ? "Calculando..." : "Calcular"}
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                O CEP é salvo na sacola e já virá preenchido no checkout.
              </p>

              {isQuoting && (
                <p
                  role="status"
                  className="mt-2 text-xs font-semibold text-gray-600 dark:text-gray-300"
                >
                  Calculando entrega...
                </p>
              )}

              {quoteError && !isQuoting && (
                <p
                  role="alert"
                  className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold leading-relaxed text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                >
                  {quoteError}
                </p>
              )}

              {deliveryOutOfRange && !isQuoting && (
                <div
                  role="alert"
                  className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                >
                  <p className="font-semibold">{deliveryOutOfRangeMessage}</p>
                  <p className="mt-1">
                    Altere o CEP ou, se preferir, combine a retirada no local
                    com a loja.
                  </p>
                  {pickupContactHref && (
                    <a
                      href={pickupContactHref}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block font-bold underline"
                    >
                      Falar com a loja sobre retirada
                    </a>
                  )}
                </div>
              )}

              {!deliveryOutOfRange &&
                quoteWarnings.map((warning) => (
                  <p
                    key={warning}
                    role="status"
                    className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    {warning}
                  </p>
                ))}
            </section>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 pb-6 pt-4 dark:border-gray-700">
          {storeClosed && (
            <p
              role="status"
              className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
            >
              O estabelecimento encontra-se fechado no momento e não está
              recebendo pedidos.
              {nextOpeningLabel ? ` Abrimos ${nextOpeningLabel}.` : ""}
            </p>
          )}

          {hasPriceOnRequest ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-semibold leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              Há itens “Sob Consulta” na sacola: o valor total será verificado
              diretamente com o atendente via WhatsApp.
            </p>
          ) : (
            <dl className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-gray-500 dark:text-gray-400">Subtotal</dt>
                <dd className="font-semibold tabular-nums text-gray-900 dark:text-white">
                  {formatBRL(subtotal)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-gray-500 dark:text-gray-400">{feeLabel}</dt>
                <dd className="font-semibold tabular-nums text-gray-900 dark:text-white">
                  {feeDisplay}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-2 text-base dark:border-gray-700">
                <dt className="font-bold text-gray-900 dark:text-white">Total</dt>
                <dd className="font-bold tabular-nums text-gray-900 dark:text-white">
                  {totalDisplay}
                </dd>
              </div>
            </dl>
          )}

          {checkoutHint && !directWhatsAppCheckout && (
            <p
              role={deliveryOutOfRange || quoteError ? "alert" : "status"}
              className={`mt-3 rounded-xl px-3 py-2 text-xs font-semibold leading-relaxed ${
                deliveryOutOfRange || quoteError
                  ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                  : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              }`}
            >
              {checkoutHint}
            </p>
          )}

          <button
            type="button"
            onClick={directWhatsAppCheckout ? handleSendDirect : handleCheckout}
            disabled={!canSubmit}
            className="mt-3 w-full rounded-xl bg-gray-900 px-4 py-3.5 text-sm font-bold text-white transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-400 disabled:text-gray-100 disabled:hover:bg-gray-400 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:focus:ring-yellow-400 dark:focus:ring-offset-gray-900 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
          >
            {directWhatsAppCheckout
              ? "Enviar Pedido / Orçamento no WhatsApp"
              : "Avançar para o Checkout"}
          </button>

          {directWhatsAppCheckout && (
            <p className="mt-2 text-center text-[11px] font-medium leading-relaxed text-gray-500 dark:text-gray-400">
              O pedido abre direto na conversa com a loja. Frete, pagamento e
              valores são combinados com o atendente.
            </p>
          )}

          {directWhatsAppCheckout && directError && (
            <p
              role="alert"
              className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold leading-relaxed text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
            >
              {directError}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}


