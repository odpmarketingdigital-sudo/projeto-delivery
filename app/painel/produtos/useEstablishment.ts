"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/context/AuthContext";

/** Estabelecimento mínimo necessário para o seletor do painel de produtos. */
export interface EstablishmentOption {
  id: string;
  name: string;
}

interface UseEstablishmentResult {
  /** Lista de estabelecimentos disponíveis (1 para admin; todos p/ super admin). */
  establishments: EstablishmentOption[];
  /** establishment_id atualmente selecionado (null enquanto não resolvido). */
  selectedId: string | null;
  /** true quando o utilizador é super_admin (pode trocar de estabelecimento). */
  isSuperAdmin: boolean;
  /** Carregando a lista de estabelecimentos. */
  isLoading: boolean;
  /** Erro de carregamento (ex.: sem estabelecimento associado). */
  error: string | null;
  /** Troca o estabelecimento selecionado (apenas relevante p/ super admin). */
  select: (id: string) => void;
}

/**
 * Resolve o(s) estabelecimento(s) do utilizador logado.
 *
 * - `admin`: a RLS (`establishments_select_own`) devolve apenas a própria loja;
 *   ela é selecionada automaticamente e não pode ser trocada.
 * - `super_admin`: a RLS (`establishments_select_super_admin`) devolve todas;
 *   a primeira é pré-selecionada e o utilizador pode alternar pelo dropdown.
 */
export function useEstablishment(): UseEstablishmentResult {
  const supabase = useMemo(() => createClient(), []);
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  // Deep-link: um super admin pode chegar com `?establishment_id=...` na URL
  // (ex.: ao clicar em "Acessar Painel" na Gestão de Estabelecimentos). Lido de
  // forma segura para SSR — só existe `window` no navegador.
  const establishmentIdFromUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("establishment_id");
  }, []);

  const [establishments, setEstablishments] = useState<EstablishmentOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from("establishments")
      .select("id, name")
      .order("name", { ascending: true });

    if (queryError) {
      setEstablishments([]);
      setSelectedId(null);
      setError(
        "Não foi possível carregar os estabelecimentos. Verifique se a tabela establishments existe."
      );
    } else {
      const list = (data as EstablishmentOption[]) ?? [];
      setEstablishments(list);
      setSelectedId((prev) => {
        if (prev) return prev;
        // Prioriza o estabelecimento vindo da URL (deep-link do super admin),
        // desde que ele conste na lista permitida pela RLS.
        if (
          establishmentIdFromUrl &&
          list.some((est) => est.id === establishmentIdFromUrl)
        ) {
          return establishmentIdFromUrl;
        }
        // Senão, o primeiro (para admin, é o único — o seu).
        return list[0]?.id ?? null;
      });
      if (list.length === 0) {
        setError(
          "Nenhum estabelecimento associado à sua conta. Fale com o administrador."
        );
      }
    }
  }, [supabase, establishmentIdFromUrl]);

  // Carregamento inicial (IIFE assíncrona: o setState de loading acontece no
  // efeito, enquanto `load` só altera estado após o await — espelha o padrão
  // de admin/page.tsx e evita renders em cascata).
  useEffect(() => {
    let active = true;
    (async () => {
      setIsLoading(true);
      setError(null);
      await load();
      if (active) setIsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [load]);

  const select = useCallback(
    (id: string) => {
      // Um admin nunca troca de estabelecimento — apenas o super admin pode.
      if (isSuperAdmin) setSelectedId(id);
    },
    [isSuperAdmin]
  );

  return {
    establishments,
    selectedId,
    isSuperAdmin,
    isLoading,
    error,
    select,
  };
}
