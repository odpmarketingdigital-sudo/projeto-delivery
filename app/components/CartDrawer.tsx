"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/context/CartContext";
import {
  formatTravelDuration,
  parseCep,
  type DeliveryQuote,
} from "@/lib/delivery";
import {
  buildCatalogWhatsAppUrl,
  isCartItemPriceOnRequest,
  isDirectWhatsAppCheckoutEnabled,
} from "@/lib/catalogOrder";
import type { StorefrontInfo } from "@/lib/types";
import {
  describeMinOrderShortfall,
  normalizeMinOrderValue,
} from "@/lib/minOrder";
import {
  halfHalfFlavorsLabel,
  withHalfHalfLabel,
} from "@/lib/halfHalf";
import { AddressAutocomplete } from "@/app/components/AddressAutocomplete";
import {
  isGooglePlacesEnabled,
  type GooglePlaceAddress,
} from "@/lib/googleMapsPlaces";

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

/** Cotação vinculada à chave loja+endereço que a originou. */
interface DeliveryQuoteState {
  key: string;
  quote: DeliveryQuotePreview | null;
  error: string | null;
  loading: boolean;
}

/**
 * Endereço escolhido no autocomplete da sacola.
 *
 * O `cep` vem do Google e é usado apenas como dado do endereço (link do modo
 * catálogo e conferência da cotação) — o cliente não digita CEP.
 */
interface SelectedDeliveryPlace {
  /** CEP devolvido pelo Google (somente dígitos) ou `""`. */
  cep: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  /** Texto do endereço para exibição (ex.: "Rua das Flores, 123 - Centro"). */
  label: string;
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
 *  - loja por distância (ou com raio máximo): busca o endereço pelo
 *    autocomplete do Google (coordenadas exatas), consulta
 *    `/api/delivery-quote`, mostra distância/tempo/valor e guarda o endereço no
 *    contexto do carrinho (o checkout abre pré-preenchido);
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
    setDeliveryCep,
    deliveryAddress,
    setDeliveryAddress,
    orderType,
    setOrderType,
  } = useCart();

  /**
   * Retirada no balcão: o cliente não paga taxa de entrega e não precisa
   * informar endereço. A escolha fica no contexto (persistida) e chega ao
   * checkout já marcada.
   */
  const isPickup = orderType === "retirada";

  // Texto do campo de endereço (o widget do Google escreve aqui; o valor só é
  // usado para exibição — quem manda na cotação são as coordenadas).
  const [addressInput, setAddressInput] = useState("");
  // Coordenadas do endereço escolhido no autocomplete (destino preferido).
  const [selectedPlace, setSelectedPlace] =
    useState<SelectedDeliveryPlace | null>(null);
  // Falha ao montar o link do WhatsApp (ex.: loja sem telefone cadastrado).
  const [directError, setDirectError] = useState<string | null>(null);
  // Último endereço sincronizado do contexto (guarda contra loop de render).
  const [lastSyncedAddress, setLastSyncedAddress] = useState(deliveryAddress);

  /**
   * O contexto pode hidratar depois da primeira renderização (localStorage):
   * o último endereço usado no frete volta para o campo e para a cotação — sem
   * sobrescrever um valor que o cliente já tenha digitado nesta sacola.
   */
  if (deliveryAddress && deliveryAddress !== lastSyncedAddress) {
    setLastSyncedAddress(deliveryAddress);
    const label = [deliveryAddress.street, deliveryAddress.number]
      .filter(Boolean)
      .join(", ");
    setAddressInput((current) => current.trim() || label);
    if (
      !selectedPlace &&
      deliveryAddress.latitude != null &&
      deliveryAddress.longitude != null
    ) {
      setSelectedPlace({
        cep: deliveryAddress.cep ?? "",
        latitude: deliveryAddress.latitude,
        longitude: deliveryAddress.longitude,
        placeId: deliveryAddress.placeId ?? null,
        label: label || "endereço salvo",
      });
    }
  }

  const establishmentId = establishment?.id ?? null;
  const deliveryType = establishment?.delivery_type ?? "fixed";
  const maxRadius = establishment?.max_delivery_radius_km ?? null;
  const needsCep = Boolean(
    establishment &&
      (deliveryType === "distance" || maxRadius != null)
  );
  /**
   * A busca automática de endereço (Google Places) é o único caminho para
   * cotar na sacola — o cliente não digita mais CEP. Sem a chave pública o
   * widget não existe, então a seção fica oculta e a taxa é calculada no
   * checkout a partir do endereço digitado lá.
   */
  const placesEnabled = isGooglePlacesEnabled();
  // Texto de apoio da seção de entrega da sacola.
  const deliveryIntro =
    deliveryType === "distance"
      ? "Busque seu endereço para cotar a taxa e o tempo pela rota real."
      : "Busque seu endereço para confirmar a entrega nesta região.";
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

  // CEP devolvido pela busca automática (usado no link do modo catálogo).
  const cepDigits = parseCep(selectedPlace?.cep ?? "");
  // Destino da cotação: coordenadas do endereço escolhido no autocomplete.
  const placePoint = selectedPlace;
  const hasDestination = Boolean(placePoint);
  // A chave inclui as coordenadas: trocar o endereço sugerido invalida a
  // cotação anterior e força um novo cálculo de rota no Google Routes.
  const pointKey = placePoint
    ? `${placePoint.latitude.toFixed(5)},${placePoint.longitude.toFixed(5)}`
    : "";
  const quoteKey =
    establishmentId && needsCep && hasDestination
      ? `${establishmentId}:${pointKey}`
      : null;

  const [quoteState, setQuoteState] = useState<DeliveryQuoteState | null>(null);
  // Incrementado pelo botão "Calcular" para refazer a consulta imediatamente.
  const [quoteAttempt, setQuoteAttempt] = useState(0);

  useEffect(() => {
    if (!open || !quoteKey || !establishmentId) return;

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
            cep: cepDigits ?? undefined,
            latitude: placePoint?.latitude,
            longitude: placePoint?.longitude,
            place_id: placePoint?.placeId ?? undefined,
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
  }, [open, quoteKey, quoteAttempt, establishmentId, cepDigits, placePoint]);

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
  // Tempo de percurso estimado pelo Google Routes (null no fallback Haversine).
  const deliveryDurationLabel = formatTravelDuration(
    quote?.duration_minutes ?? null
  );
  // Na retirada não existe entrega: ignora a cotação (que pode ter sido feita
  // antes de o cliente trocar a modalidade) e cobra apenas o subtotal.
  const deliveryOutOfRange = !isPickup && quote?.within_radius === false;
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
  /**
   * A cotação na sacola só é obrigatória quando a busca automática de endereço
   * está disponível (é o único jeito de cotar ali). Sem a chave do Google, o
   * frete é calculado no checkout a partir do endereço digitado, que o
   * servidor geocodifica.
   */
  const quoteReady =
    isPickup ||
    !needsCep ||
    !placesEnabled ||
    (quote != null && !quoteError && !isQuoting);

  // Modo catálogo: a loja recebe o pedido/orçamento direto no WhatsApp e o
  // cliente não passa pelo checkout. Ausência do campo = fluxo tradicional.
  const directWhatsAppCheckout = isDirectWhatsAppCheckoutEnabled(establishment);
  // Pelo menos um item "Sob Consulta": esconde os totais (o valor é combinado).
  const hasPriceOnRequest = cartItems.some((item) =>
    isCartItemPriceOnRequest(item)
  );

  // Pedido mínimo da loja (subtotal dos itens, SEM a taxa de entrega). Itens
  // "Sob Consulta" ficam de fora da regra: o valor é combinado com o atendente.
  const minOrderValue = normalizeMinOrderValue(establishment?.min_order_value);
  const minOrderMessage = hasPriceOnRequest
    ? null
    : describeMinOrderShortfall(minOrderValue, subtotal);
  const minOrderBlocked = minOrderMessage != null;

  const canCheckout =
    establishment != null &&
    itemCount > 0 &&
    !storeClosed &&
    quoteReady &&
    !deliveryOutOfRange &&
    !minOrderBlocked;

  // No envio direto o endereço/frete não bloqueia o pedido — só itens, pedido
  // mínimo (quando os valores são conhecidos) e loja aberta.
  const canSendDirect =
    establishment != null &&
    itemCount > 0 &&
    !storeClosed &&
    !minOrderBlocked;
  const canSubmit = directWhatsAppCheckout ? canSendDirect : canCheckout;

  const feeLabel = isPickup
    ? "Retirada no balcão"
    : deliveryDistanceKm != null
      ? `Entrega (${formatKm(deliveryDistanceKm)} km)`
      : "Entrega";

  const feeDisplay = isPickup
    ? "Sem taxa"
    : deliveryFee != null
      ? formatBRL(deliveryFee)
      : isQuoting
        ? "Calculando..."
        : "A calcular";

  const totalDisplay = isPickup
    ? formatBRL(subtotal)
    : deliveryFee != null
      ? formatBRL(subtotal + deliveryFee)
      : "A calcular";

  let checkoutHint: string | null = null;
  if (!establishment) {
    checkoutHint = "Carregando informações da loja...";
  } else if (isPickup) {
    checkoutHint = null;
  } else if (deliveryOutOfRange) {
    checkoutHint =
      "Altere o endereço ou, se preferir, combine a retirada no local com a loja.";
  } else if (needsCep && placesEnabled && !hasDestination) {
    checkoutHint =
      deliveryType === "distance"
        ? "Busque seu endereço para calcular a entrega."
        : "Busque seu endereço para validar a área de entrega.";
  } else if (isQuoting) {
    checkoutHint = "Calculando o frete...";
  } else if (quoteError) {
    checkoutHint = quoteError;
  } else if (needsCep && placesEnabled && !quote) {
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

  /**
   * Endereço escolhido no autocomplete da sacola.
   *
   * As coordenadas (e o `place_id`) são enviadas para `/api/delivery-quote`,
   * que calcula a rota/tempo na Google Routes API. O endereço completo é salvo
   * no contexto (`deliveryAddress`) para o checkout já abrir preenchido.
   */
  const handleAddressSelected = (address: GooglePlaceAddress) => {
    const cep = parseCep(address.cep ?? "") ?? "";
    const street = address.street?.trim() ?? "";
    const number = address.number?.trim() ?? "";
    const neighborhood = address.neighborhood?.trim() ?? "";
    const city = address.city?.trim() ?? "";
    const label =
      address.formattedAddress?.trim() ||
      [street, number].filter(Boolean).join(", ").trim();

    setAddressInput(street || label);
    setSelectedPlace(
      address.latitude != null && address.longitude != null
        ? {
            cep,
            latitude: address.latitude,
            longitude: address.longitude,
            placeId: address.placeId,
            label,
          }
        : null
    );

    // Mantém a sacola e o link do modo catálogo em sincronia com o endereço.
    setDeliveryCep(cep);
    setDeliveryAddress({
      street,
      number,
      neighborhood,
      ...(city ? { city } : {}),
      ...(cep ? { cep } : {}),
      ...(address.latitude != null && address.longitude != null
        ? { latitude: address.latitude, longitude: address.longitude }
        : {}),
      ...(address.placeId ? { placeId: address.placeId } : {}),
      // Feedback visual no checkout (o pedido usa rua/número + coordenadas).
      ...(address.formattedAddress?.trim()
        ? { formattedAddress: address.formattedAddress.trim() }
        : {}),
    });
  };

  /** Digitação/colagem no campo: invalida as coordenadas da sugestão anterior. */
  const handleAddressChange = (value: string) => {
    setAddressInput(value);
    if (selectedPlace) setSelectedPlace(null);
  };

  const handleCalculate = () => {
    if (!quoteKey) return;
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
          name: withHalfHalfLabel(item.productName, item.halfHalfFlavors),
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
      deliveryCep: isPickup ? null : cepDigits ?? null,
      // Retirada: a mensagem avisa que o cliente busca no balcão (sem CEP).
      deliveryType: orderType,
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
                        {item.halfHalfFlavors && item.halfHalfFlavors.length > 0 && (
                          <p className="mt-0.5 text-xs font-semibold leading-relaxed text-amber-700 dark:text-amber-300">
                            {halfHalfFlavorsLabel(item.halfHalfFlavors)}
                          </p>
                        )}
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

          {/*
            Modalidade de atendimento: entrega em casa (cobra taxa e exige
            endereço) ou retirada no balcão (sem taxa, sem endereço). A escolha
            é persistida no contexto e chega marcada no checkout.
          */}
          {cartItems.length > 0 && (
          <fieldset className="mt-5">
            <legend className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Como você quer receber?
            </legend>
            <div
              role="radiogroup"
              aria-label="Modalidade de atendimento"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <button
                type="button"
                role="radio"
                aria-checked={!isPickup}
                onClick={() => setOrderType("entrega")}
                className={`rounded-xl border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-yellow-400 ${
                  !isPickup
                    ? "border-gray-900 bg-gray-50 shadow-sm dark:border-yellow-400 dark:bg-gray-900/60"
                    : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-600"
                }`}
              >
                <span className="block text-sm font-semibold text-gray-900 dark:text-white">
                  Receber em casa
                </span>
                <span className="block text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                  Delivery no endereço informado
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={isPickup}
                onClick={() => setOrderType("retirada")}
                className={`rounded-xl border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-yellow-400 ${
                  isPickup
                    ? "border-gray-900 bg-gray-50 shadow-sm dark:border-yellow-400 dark:bg-gray-900/60"
                    : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-gray-600"
                }`}
              >
                <span className="block text-sm font-semibold text-gray-900 dark:text-white">
                  Retirar no estabelecimento
                </span>
                <span className="block text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                  Sem taxa de entrega — você busca no balcão
                </span>
              </button>
            </div>
          </fieldset>
          )}

          {!isPickup && needsCep && placesEnabled && (
            <section
              aria-labelledby="cart-delivery-title"
              className="mt-5 rounded-2xl border border-gray-200 bg-gray-50/70 p-4 dark:border-gray-700 dark:bg-gray-800/40"
            >
              <h3
                id="cart-delivery-title"
                className="text-sm font-bold text-gray-900 dark:text-white"
              >
                {deliveryType === "distance"
                  ? "Calcular entrega"
                  : "Validar área de entrega"}
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                {deliveryIntro}
              </p>

              {placesEnabled && (
                <div className="mt-3">
                  <label
                    htmlFor="cart-delivery-address"
                    className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-300"
                  >
                    Endereço
                  </label>
                  <AddressAutocomplete
                    id="cart-delivery-address"
                    name="cart-delivery-address"
                    placeholder="Ex.: Rua das Flores, 123"
                    autoComplete="address-line1"
                    ariaLabel="Endereço de entrega"
                    value={addressInput}
                    onChange={handleAddressChange}
                    onPlaceSelected={handleAddressSelected}
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/20 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                  />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                    Escolha uma sugestão para preencher o endereço completo.
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={handleCalculate}
                disabled={!hasDestination || isQuoting}
                className="mt-3 inline-flex w-full items-center justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-400 dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
              >
                {isQuoting ? "Calculando..." : "Calcular entrega"}
              </button>
              <p className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                O endereço é salvo na sacola e já virá preenchido no checkout.
              </p>

              {placePoint && !isQuoting && (
                <p className="mt-2 break-words rounded-lg bg-white px-3 py-2 text-[11px] font-medium leading-relaxed text-gray-600 dark:bg-gray-900/60 dark:text-gray-300">
                  Entrega para:{" "}
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {placePoint.label || addressInput || "endereço selecionado"}
                  </span>
                </p>
              )}

              {quote && !isQuoting && !deliveryOutOfRange && (
                <p
                  role="status"
                  className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold leading-relaxed text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300"
                >
                  {deliveryDistanceKm != null
                    ? `${formatKm(deliveryDistanceKm)} km`
                    : "Distância estimada"}
                  {deliveryDurationLabel ? ` · ~${deliveryDurationLabel}` : ""} ·{" "}
                  {formatBRL(quote.fee)}
                </p>
              )}

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
                    Altere o endereço ou, se preferir, combine a retirada no
                    local com a loja.
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

          {minOrderMessage && (
            <p
              role="alert"
              className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {minOrderMessage}
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


