"use client";

import { useSyncExternalStore } from "react";

/**
 * Flag de MONTAGEM no cliente — proteção contra divergência de hidratação.
 *
 * Retorna `false` no servidor **e no primeiro render do cliente** (o React usa
 * o snapshot do servidor durante a hidratação) e `true` logo depois, quando o
 * componente já está montado no navegador. Serve para isolar tudo o que só
 * existe no cliente — `localStorage` / `sessionStorage`, relógio do navegador
 * (`new Date()`), `matchMedia`, `window.location` — do HTML gerado no
 * servidor: servidor e cliente produzem exatamente o mesmo markup na primeira
 * passada e o conteúdo real entra no render seguinte.
 *
 * Por que `useSyncExternalStore` em vez de `useState` + `useEffect`?
 *
 *  - `useEffect(() => setIsMounted(true), [])` é reprovado pelo ESLint deste
 *    projeto (regra `react-hooks/set-state-in-effect`, que trata setState
 *    síncrono no corpo do efeito como erro de render em cascata);
 *  - este é o padrão recomendado pelo React para "detectar hidratação sem
 *    efeitos colaterais" e já é usado no `CartContext` (`isHydrated`), então
 *    mantém uma única técnica de hidratação no projeto.
 *
 * Use sempre como guarda de renderização (`isMounted && <AlgoComDadosDoBrowser />`)
 * — nunca para decidir navegação ou para ler o storage dentro de handlers.
 *
 * @example
 * const isMounted = useIsMounted();
 * const status = isMounted && menu ? isStoreOpen(menu.opening_hours, now) : null;
 */
export function useIsMounted(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}

/**
 * Nada a observar: o valor só muda uma vez (servidor → cliente), e o React
 * reavalia o snapshot por conta própria logo após a hidratação. A referência
 * fica no escopo do módulo porque funções inline recriadas a cada render
 * fariam o React revalidar o snapshot continuamente.
 */
const subscribe = () => () => undefined;

const getClientSnapshot = () => true;

const getServerSnapshot = () => false;
