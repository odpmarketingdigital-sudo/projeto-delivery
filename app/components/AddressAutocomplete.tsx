"use client";

import { useEffect, useRef, useState } from "react";
import {
  extractPlaceAddress,
  isGooglePlacesEnabled,
  loadGooglePlacesAutocomplete,
  type GoogleAutocomplete,
  type GooglePlaceAddress,
} from "@/lib/googleMapsPlaces";

/**
 * Input de endereço com **Google Places Autocomplete**.
 *
 * Comportamento:
 *  - sem `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, renderiza um input comum (o
 *    checkout continua funcionando com o CEP e o cálculo por distância);
 *  - com a chave, carrega a Maps JS API uma única vez e mostra sugestões de
 *    endereço em tempo real (Brasil, tipo `address`);
 *  - ao selecionar uma sugestão, o componente pai recebe rua, número, bairro,
 *    cidade, estado, CEP e as coordenadas (`lat`/`lng`) preenchidos.
 *
 * O widget do Google é criado uma única vez por elemento `<input>` (WeakMap):
 * remontagens do checkout reutilizam a mesma instância e apenas religam o
 * listener `place_changed`.
 */

const autocompleteByInput = new WeakMap<HTMLInputElement, GoogleAutocomplete>();

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
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Callbacks em refs: o listener do Google é registrado uma única vez e deve
  // sempre chamar a versão mais recente das funções do componente pai.
  const onChangeRef = useRef(onChange);
  const onPlaceSelectedRef = useRef(onPlaceSelected);
  const [isAutocompleteReady, setIsAutocompleteReady] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onPlaceSelectedRef.current = onPlaceSelected;
  }, [onPlaceSelected]);

  useEffect(() => {
    if (!isGooglePlacesEnabled()) return;
    const input = inputRef.current;
    if (!input) return;

    let cancelled = false;
    let listener: { remove(): void } | null = null;

    void (async () => {
      const AutocompleteCtor = await loadGooglePlacesAutocomplete();
      if (cancelled || !AutocompleteCtor || !inputRef.current) return;

      const autocomplete =
        autocompleteByInput.get(inputRef.current) ??
        new AutocompleteCtor(inputRef.current, {
          fields: [
            "address_components",
            "formatted_address",
            "geometry",
            "place_id",
          ],
          types: ["address"],
          componentRestrictions: { country: "br" },
        });
      autocompleteByInput.set(inputRef.current, autocomplete);

      listener = autocomplete.addListener("place_changed", () => {
        const address = extractPlaceAddress(autocomplete.getPlace());
        if (!address) return;
        // O Google escreve o endereço completo no input; devolvemos apenas a
        // rua para manter o formulário consistente (número/bairro têm campos
        // próprios) e o React no controle do valor.
        const nextValue = address.street ?? address.formattedAddress ?? "";
        onChangeRef.current(nextValue);
        // Sincroniza o DOM imediatamente: se o valor da rua for igual ao já
        // existente, o React não reescreve o input e o texto completo do Google
        // permaneceria visível até o próximo render.
        if (inputRef.current) inputRef.current.value = nextValue;
        onPlaceSelectedRef.current(address);
      });

      if (!cancelled) setIsAutocompleteReady(true);
    })();

    return () => {
      cancelled = true;
      listener?.remove();
    };
  }, []);

  return (
    <>
      <input
        ref={inputRef}
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
      {isAutocompleteReady && (
        <p className="mt-1 text-[10px] font-medium tracking-wide text-gray-400 dark:text-gray-500">
          Sugestões do Google ao digitar
        </p>
      )}
    </>
  );
}
