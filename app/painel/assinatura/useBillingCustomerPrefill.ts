"use client";

import { useEffect, useState } from "react";
import type {
  BillingCustomerPrefill,
  BillingCustomerPrefillResponse,
} from "@/lib/billing";

/**
 * Busca os dados já cadastrados da loja para pré-preencher o passo 1 do modal
 * de assinatura (`GET /api/billing/customer`).
 *
 * A tela de assinatura chama este hook ao montar, em paralelo com a leitura da
 * assinatura, para que o modal já abra preenchido. Quando a loja ainda não está
 * definida (`establishmentId === null`, caso do super_admin sem loja
 * selecionada) nada é buscado e o modal abre em branco, como antes.
 *
 * Falhas (rede, 401, 403) não bloqueiam o checkout: `prefill` fica `null` e os
 * campos continuam editáveis — o lojista só precisa digitá-los.
 */
export interface BillingCustomerPrefillState {
  /** Dados cadastrados; `null` enquanto carrega ou quando não há loja. */
  prefill: BillingCustomerPrefill | null;
  /** `true` enquanto a requisição da loja atual não terminou. */
  isLoading: boolean;
}

/** Resultado da busca, atrelado à loja consultada. */
interface PrefillResult {
  establishmentId: string;
  customer: BillingCustomerPrefill | null;
}

export function useBillingCustomerPrefill(
  establishmentId: string | null
): BillingCustomerPrefillState {
  const [result, setResult] = useState<PrefillResult | null>(null);

  useEffect(() => {
    if (!establishmentId) return;

    // Evita gravar estado de uma loja que já não é a atual (troca de loja pelo
    // super_admin) ou depois do unmount.
    let active = true;

    const query = `?establishment_id=${encodeURIComponent(establishmentId)}`;

    fetch(`/api/billing/customer${query}`, { cache: "no-store" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<BillingCustomerPrefillResponse>)
          : null
      )
      .then((data: BillingCustomerPrefillResponse | null) => {
        if (!active) return;
        setResult({ establishmentId, customer: data?.customer ?? null });
      })
      .catch(() => {
        if (!active) return;
        setResult({ establishmentId, customer: null });
      });

    return () => {
      active = false;
    };
  }, [establishmentId]);

  const settled =
    result && result.establishmentId === establishmentId ? result : null;

  return {
    prefill: settled?.customer ?? null,
    isLoading: Boolean(establishmentId) && settled === null,
  };
}
