"use client";

import { useEffect, useState } from "react";
import type { OrderStatus, PanelOrder } from "@/lib/types";

/**
 * Hook + helpers do menu condicional "Acompanhar Pedido" da vitrine.
 *
 * A sessão do cliente é identificada pelo telefone salvo no localStorage
 * (mesmas chaves da página "Meus Pedidos"), consultado contra a loja atual
 * via `GET /api/orders/customer` (pública, aceita UUID ou slug).
 *
 * Regra de exibição:
 *  - `pendente` / `preparando` / `entrega` → sempre elegíveis (em andamento);
 *  - `finalizado` → elegível SOMENTE quando `created_at` ou `updated_at`
 *    cair no dia corrente (local do cliente);
 *  - `cancelado` → nunca.
 *
 * Quando há correspondência, o menu aponta para o pedido ATIVO mais recente
 * (`/pedido/[id]`); caso contrário, o link fica oculto.
 */

/** Chave do localStorage com o telefone do cliente (padrão "Meus Pedidos"). */
const CUSTOMER_PHONE_KEY = "customer_phone";
/** Chave legada mantida como fallback para compatibilidade. */
const LEGACY_PHONE_KEY = "delivery_last_phone";

/** Status em andamento — sempre habilitam o acompanhamento. */
const IN_PROGRESS_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "pendente",
  "preparando",
  "entrega",
]);

/** Status "concluído" — só habilita o acompanhamento no dia do pedido. */
const COMPLETED_STATUS: OrderStatus = "finalizado";

/** Campos mínimos usados pela regra de exibição/ordenação. */
type TrackableOrderFields = Pick<
  PanelOrder,
  "id" | "status" | "created_at" | "updated_at"
>;

/** Lê o telefone salvo pela sessão do cliente (somente no navegador). */
function readSavedPhone(): string {
  try {
    return (
      localStorage.getItem(CUSTOMER_PHONE_KEY) ||
      localStorage.getItem(LEGACY_PHONE_KEY) ||
      ""
    );
  } catch {
    /* localStorage indisponível (modo privado/bloqueado). */
    return "";
  }
}

/** Converte uma data ISO para epoch; 0 quando inválida (evita NaN no sort). */
function timeOf(iso: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** `true` quando a data ISO representa o dia local corrente do cliente. */
function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const d = new Date(t);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * Aplica a regra de exibição do menu a um pedido:
 * em andamento → sempre; concluído → apenas se for de hoje.
 */
export function isTrackableOrder(order: TrackableOrderFields): boolean {
  if (IN_PROGRESS_STATUSES.has(order.status)) return true;
  if (order.status === COMPLETED_STATUS) {
    return isToday(order.created_at) || isToday(order.updated_at);
  }
  return false;
}

/**
 * Escolhe o pedido para o link "Acompanhar Pedido": o mais recente entre os
 * elegíveis, priorizando os EM ANDAMENTO sobre os concluídos de hoje.
 * Retorna `null` quando nenhum pedido atende à regra (menu oculto).
 */
export function pickTrackableOrderId(
  orders: TrackableOrderFields[]
): string | null {
  const eligible = orders.filter(isTrackableOrder);
  if (eligible.length === 0) return null;

  const byNewestFirst = (a: TrackableOrderFields, b: TrackableOrderFields) =>
    timeOf(b.created_at) - timeOf(a.created_at);

  const inProgress = eligible.filter((o) => IN_PROGRESS_STATUSES.has(o.status));
  const pool = inProgress.length > 0 ? inProgress : eligible;
  return [...pool].sort(byNewestFirst)[0]?.id ?? null;
}

export interface TrackableOrderResult {
  /** Id do pedido a acompanhar ou `null` (menu oculto). */
  orderId: string | null;
  /** `true` enquanto a primeira consulta ainda não resolveu. */
  isLoading: boolean;
}

/**
 * Consulta os pedidos recentes da sessão do cliente na loja atual e aplica a
 * regra do menu "Acompanhar Pedido".
 *
 * @param establishmentKey UUID ou slug da loja atual (`null` → sem consulta).
 */
export function useTrackableOrder(
  establishmentKey: string | null | undefined
): TrackableOrderResult {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Decisão e todos os setState acontecem APENAS após um `await` — evita
      // re-render síncrono em efeito (regra react-hooks/set-state-in-effect).
      await Promise.resolve();
      if (cancelled) return;

      const phoneDigits = readSavedPhone().replace(/\D/g, "");
      if (!establishmentKey || phoneDigits.length < 10) {
        // Sem loja identificada ou sem telefone na sessão → menu oculto.
        setOrderId(null);
        setIsLoading(false);
        return;
      }

      // O `isLoading` é apenas o da PRIMEIRA consulta (estado inicial `true`).
      // Reconsultas (ex.: troca de loja) atualizam o link em silêncio, sem
      // reexibir o estado de carregamento da vitrine.
      try {
        const query = new URLSearchParams();
        query.set("phone", phoneDigits);
        query.set("establishment_id", establishmentKey);
        const res = await fetch(`/api/orders/customer?${query.toString()}`, {
          cache: "no-store",
        });
        // 404 = nenhum pedido para este telefone; corpo segue `{ orders: [] }`.
        const body = (await res.json().catch(() => ({}))) as {
          orders?: TrackableOrderFields[];
        };
        if (cancelled) return;
        const orders = Array.isArray(body.orders) ? body.orders : [];
        setOrderId(pickTrackableOrderId(orders));
      } catch {
        // Falha de rede/servidor → não exibe o menu (não quebra a vitrine).
        if (!cancelled) setOrderId(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [establishmentKey]);

  return { orderId, isLoading };
}
