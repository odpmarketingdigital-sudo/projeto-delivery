"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useOrderSound, type UseOrderSoundResult } from "./useOrderSound";

const OrderSoundContext = createContext<UseOrderSoundResult | null>(null);

/**
 * Mantém o elemento de áudio (`/sound/sound.mp3`) e o estado de
 * ativação/silêncio vivos durante a navegação entre as telas do painel. Como o
 * layout de `/painel` é preservado pelo App Router, o operador ativa o som uma
 * única vez e ele continua armado ao alternar entre Pedidos, Dashboard,
 * Produtos etc.
 *
 * O contexto só é encerrado quando o usuário sai do painel (ou recarrega a
 * página), momento em que o navegador volta a exigir um gesto para liberar o
 * áudio.
 */
export function OrderSoundProvider({ children }: { children: ReactNode }) {
  const sound = useOrderSound();

  return (
    <OrderSoundContext.Provider value={sound}>
      {children}
    </OrderSoundContext.Provider>
  );
}

/** Acesso ao alerta sonoro compartilhado pelo layout do painel. */
export function useOrderSoundContext(): UseOrderSoundResult {
  const sound = useContext(OrderSoundContext);
  if (!sound) {
    throw new Error(
      "useOrderSoundContext deve ser usado dentro de OrderSoundProvider."
    );
  }
  return sound;
}
