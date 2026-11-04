"use client";

import { useEffect, useRef, useState } from "react";
import {
  isGooglePlacesEnabled,
  loadGooglePlaceAutocompleteElement,
  readSelectedPlaceAddress,
  type GooglePlaceAddress,
  type GooglePlaceAutocompleteElement,
  type GooglePlaceSelectEvent,
} from "@/lib/googleMapsPlaces";

/**
 * Input de endereço com **Google Places API (New)**.
 *
 * Comportamento:
 *  - sem `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, renderiza um input comum (o
 *    checkout continua funcionando com o CEP e o cálculo por distância);
 *  - com a chave, carrega a Maps JS API uma única vez e injeta o Web Component
 *    `google.maps.places.PlaceAutocompleteElement` (`<gmp-place-autocomplete>`),
 *    que sugere endereços no Brasil em tempo real;
 *  - ao selecionar uma sugestão (`gmp-select`), `placePrediction.toPlace()` +
 *    `fetchFields()` preenchem rua, número, bairro, cidade, estado, CEP e as
 *    coordenadas (`lat`/`lng`) no formulário.
 *
 * O widget é criado em um `<div>` próprio (e não em um `<input>`) porque o
 * elemento do Google renderiza o campo em shadow DOM. Enquanto ele carrega —
 * ou se a API falhar — o input controlado pelo React continua visível.
 */

/** Restringe as sugestões ao Brasil (ISO 3166-1 alpha-2). */
const INCLUDED_REGION_CODES = ["br"];

/**
 * Nome do evento de seleção: `gmp-select` na Places UI Kit atual;
 * `gmp-placeselect` era o nome nas primeiras versões do Web Component.
 */
const SELECT_EVENTS = ["gmp-select", "gmp-placeselect"] as const;

/** Classe aplicada ao widget (ver `app/globals.css`). */
const WIDGET_CLASS_NAME = "ipepper-place-autocomplete";

interface AddressAutocompleteProps {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onPlaceSelected: (address: GooglePlaceAddress) => void;
  placeholder?: string;
  autoComplete?: string;
  className: string;
  ariaInvalid?: boolean;
  /** Nome acessível do campo (o `<label>` não alcança o shadow DOM). */
  ariaLabel?: string;
}

export function AddressAutocomplete({
  id,
  name,
  value,
  onChange,
  onPlaceSelected,
  placeholder,
  autoComplete = "address-line1",
  className,
  ariaInvalid,
  ariaLabel = "Endereço",
}: AddressAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<GooglePlaceAutocompleteElement | null>(null);
  // Callbacks em refs: os listeners do Google são registrados uma única vez e
  // devem sempre chamar a versão mais recente das funções do componente pai.
  const onChangeRef = useRef(onChange);
  const onPlaceSelectedRef = useRef(onPlaceSelected);
  const valueRef = useRef(value);
  const [isAutocompleteReady, setIsAutocompleteReady] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onPlaceSelectedRef.current = onPlaceSelected;
  }, [onPlaceSelected]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Valor controlado pelo formulário → widget. Só escreve quando difere, para
  // não reposicionar o cursor enquanto o cliente digita.
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return;
    if (widget.value !== value) widget.value = value;
  }, [value, isAutocompleteReady]);

  // Estado de erro do formulário também no widget.
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return;
    if (ariaInvalid) widget.setAttribute("aria-invalid", "true");
    else widget.removeAttribute("aria-invalid");
  }, [ariaInvalid, isAutocompleteReady]);

  useEffect(() => {
    if (!isGooglePlacesEnabled()) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let widget: GooglePlaceAutocompleteElement | null = null;
    const listeners: Array<{ type: string; handler: EventListener }> = [];

    void (async () => {
      const PlaceAutocompleteElementCtor =
        await loadGooglePlaceAutocompleteElement();
      if (cancelled || !PlaceAutocompleteElementCtor) return;
      if (!containerRef.current) return;

      widget = new PlaceAutocompleteElementCtor({
        includedRegionCodes: INCLUDED_REGION_CODES,
        placeholder,
        name,
      });
      widget.id = id;
      widget.className = WIDGET_CLASS_NAME;
      widget.value = valueRef.current;
      widget.setAttribute("aria-label", ariaLabel);
      // O construtor do widget aceita apenas parte destas opções; reaplicamos as
      // propriedades no elemento para garantir o estado após a criação.
      widget.includedRegionCodes = INCLUDED_REGION_CODES;
      widget.placeholder = placeholder ?? "Digite o endereço";
      widget.name = name;

      const handleSelect = (event: Event) => {
        void (async () => {
          const address = await readSelectedPlaceAddress(
            event as unknown as GooglePlaceSelectEvent
          );
          if (!address || cancelled) return;
          // O Google escreve o endereço completo no campo; devolvemos apenas a
          // rua para manter o formulário consistente (número/bairro têm campos
          // próprios) e o React no controle do valor.
          const nextValue = address.street ?? address.formattedAddress ?? "";
          onChangeRef.current(nextValue);
          // Sincroniza o DOM imediatamente: se o valor da rua for igual ao já
          // existente, o React não reescreve o widget e o texto completo do
          // Google permaneceria visível até o próximo render.
          const current = widgetRef.current;
          if (current && nextValue) current.value = nextValue;
          onPlaceSelectedRef.current(address);
        })();
      };

      // Digitação/colagem: mantém o estado do formulário em sincronia com o
      // valor interno do widget (necessário para a validação do checkout).
      const handleValueChange = () => {
        const current = widgetRef.current;
        if (!current) return;
        const nextValue =
          typeof current.value === "string" ? current.value : "";
        if (nextValue !== valueRef.current) onChangeRef.current(nextValue);
      };

      const register = (type: string, handler: EventListener) => {
        widget?.addEventListener(type, handler);
        listeners.push({ type, handler });
      };

      register("input", handleValueChange);
      register("keyup", handleValueChange);
      register("focusout", handleValueChange);
      for (const type of SELECT_EVENTS) register(type, handleSelect);

      containerRef.current.replaceChildren(widget);
      widgetRef.current = widget;
      setIsAutocompleteReady(true);
    })();

    return () => {
      cancelled = true;
      for (const { type, handler } of listeners) {
        widget?.removeEventListener(type, handler);
      }
      widget?.remove();
      widgetRef.current = null;
      setIsAutocompleteReady(false);
    };
  }, [ariaLabel, id, name, placeholder]);

  return (
    <div className="w-full">
      {/*
        Host do Web Component: quando a Places API (New) está pronta, o
        `<gmp-place-autocomplete>` é inserido aqui e passa a ser o campo
        visível. O input React abaixo é o fallback (sem chave, offline ou
        enquanto o script carrega), mantendo `id`/`name` para o `<label>`
        `htmlFor` do formulário.
      */}
      <div
        ref={containerRef}
        className={isAutocompleteReady ? "block w-full" : "hidden"}
      />
      {!isAutocompleteReady && (
        <input
          id={id}
          name={name}
          type="text"
          autoComplete={autoComplete}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={ariaInvalid ? true : undefined}
          className={className}
        />
      )}
      {isAutocompleteReady && (
        <p className="mt-1 text-[10px] font-medium tracking-wide text-gray-400 dark:text-gray-500">
          Sugestões do Google ao digitar
        </p>
      )}
    </div>
  );
}
