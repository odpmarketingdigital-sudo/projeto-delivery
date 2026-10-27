"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/context/AuthContext";
import { createClient } from "@/lib/supabase/client";
import {
  getTrialDaysRemaining,
  isSubscriptionActive,
  type SubscriptionStatus,
} from "@/lib/subscriptions";

/**
 * Colunas de assinatura lidas do estabelecimento selecionado.
 * A RLS (`establishments_select_own` / `establishments_select_super_admin`)
 * garante que o admin só enxerga a própria loja.
 */
const SUBSCRIPTION_COLUMNS =
  "id, name, subscription_status, trial_ends_at, plan_id";

/** Colunas mínimas usadas quando a migração de assinaturas ainda não rodou. */
const LEGACY_COLUMNS = "id, name";

/** Mensagem única para falhas de leitura (exibida na tela de assinatura). */
const LOAD_ERROR = "Não foi possível carregar a situação da sua assinatura.";

/** Linha lida de `establishments` (só o que o painel precisa). */
interface EstablishmentSubscriptionRow {
  id: string;
  name: string | null;
  subscription_status?: SubscriptionStatus | null;
  trial_ends_at?: string | null;
  plan_id?: string | null;
}

/** Situação da assinatura exposta ao painel. */
export interface PanelSubscription {
  /** Loja usada como referência (null quando nenhuma foi encontrada). */
  establishmentId: string | null;
  establishmentName: string | null;
  status: SubscriptionStatus;
  /** Fim do trial em ISO 8601 (null fora do trial). */
  trialEndsAt: string | null;
  planId: string | null;
  /** Dias restantes de trial (0 quando não é trial ou já expirou). */
  daysRemaining: number;
  /** Resultado de `isSubscriptionActive` para a loja de referência. */
  isActive: boolean;
  isLoading: boolean;
  /** Falha ao ler a loja (a UI avisa, mas não bloqueia o acesso). */
  error: string | null;
  /**
   * As colunas de assinatura ainda não existem no banco (migração pendente).
   * Nesse caso o painel libera o acesso em vez de travar todo mundo.
   */
  isSchemaPending: boolean;
  /** Super admin nunca é bloqueado pelo paywall. */
  isSuperAdmin: boolean;
  /** Relê a situação (útil após a confirmação do pagamento na Etapa 3). */
  refresh: () => Promise<void>;
}

/** Estado sem os campos voláteis controlados pelo provider. */
type SubscriptionSnapshot = Omit<PanelSubscription, "isLoading" | "refresh">;

/** Estado padrão: libera o acesso enquanto nada foi lido (evita "flash"). */
const EMPTY_SNAPSHOT: SubscriptionSnapshot = {
  establishmentId: null,
  establishmentName: null,
  status: "active",
  trialEndsAt: null,
  planId: null,
  daysRemaining: 0,
  isActive: true,
  error: null,
  isSchemaPending: false,
  isSuperAdmin: false,
};

/** Monta o snapshot a partir da linha do banco (ou da ausência dela). */
function buildSnapshot(
  row: EstablishmentSubscriptionRow | null,
  isSchemaPending: boolean
): SubscriptionSnapshot {
  // Sem loja acessível (ex.: super admin sem lojas): não bloqueia o painel.
  if (!row) {
    return { ...EMPTY_SNAPSHOT, isActive: true, isSchemaPending };
  }

  // Migração pendente: não há status confiável para avaliar → acesso liberado.
  if (isSchemaPending) {
    return {
      ...EMPTY_SNAPSHOT,
      establishmentId: row.id,
      establishmentName: row.name,
      isActive: true,
      isSchemaPending: true,
    };
  }

  const status = row.subscription_status ?? "active";
  const trialEndsAt = row.trial_ends_at ?? null;
  const now = new Date();

  return {
    establishmentId: row.id,
    establishmentName: row.name,
    status,
    trialEndsAt,
    planId: row.plan_id ?? null,
    daysRemaining:
      status === "trialing" ? getTrialDaysRemaining(trialEndsAt, now) : 0,
    isActive: isSubscriptionActive(
      { subscription_status: status, trial_ends_at: trialEndsAt },
      now
    ),
    error: null,
    isSchemaPending: false,
    isSuperAdmin: false,
  };
}

const SubscriptionContext = createContext<PanelSubscription | null>(null);

/**
 * Mantém a situação da assinatura da loja viva durante a navegação no painel,
 * evitando que cada página (banner, guard e tela de assinatura) consulte o
 * banco separadamente.
 *
 * Resolução da loja:
 *  1. `?establishment_id=` na URL (deep-link de "Acessar Painel" do super
 *     admin);
 *  2. caso contrário, a primeira loja devolvida pela RLS — para um admin é a
 *     própria loja.
 *
 * Falhas de leitura e migração pendente são *fail-open*: o objetivo do
 * paywall é cobrar, não derrubar o painel de quem já paga por um erro de
 * infraestrutura.
 */
/**
 * `true` quando a leitura atual é idêntica à anterior.
 *
 * `refresh()` (pagamento confirmado, botão "Tentar novamente") e o efeito de
 * montagem releem a loja e devolveriam um objeto novo mesmo sem mudança — o que
 * re-renderiza o guard, o banner de trial e toda a página a cada leitura.
 */
function isSameSnapshot(
  a: SubscriptionSnapshot | null,
  b: SubscriptionSnapshot
): boolean {
  if (!a) return false;
  return (
    a.establishmentId === b.establishmentId &&
    a.establishmentName === b.establishmentName &&
    a.status === b.status &&
    a.trialEndsAt === b.trialEndsAt &&
    a.planId === b.planId &&
    a.daysRemaining === b.daysRemaining &&
    a.isActive === b.isActive &&
    a.error === b.error &&
    a.isSchemaPending === b.isSchemaPending &&
    a.isSuperAdmin === b.isSuperAdmin
  );
}

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  // Lido uma única vez por usuário: o deep-link do super admin chega na
  // primeira navegação e é preservado nas trocas de tela (`buildHref`).
  const establishmentIdFromUrl = useMemo(() => {
    if (typeof window === "undefined" || !currentUser) return null;
    return new URLSearchParams(window.location.search).get("establishment_id");
  }, [currentUser]);

  const [snapshot, setSnapshot] = useState<SubscriptionSnapshot | null>(null);
  // Deriva o loading da ausência de leitura: evita `setState` sincrono no
  // efeito (regra react-hooks/set-state-in-effect) e mantém o painel em
  // "Verificando assinatura..." até a primeira resposta.
  const isLoading = snapshot === null;

  const fetchSubscription =
    useCallback(async (): Promise<SubscriptionSnapshot> => {
      const base = supabase
        .from("establishments")
        .select(SUBSCRIPTION_COLUMNS)
        .order("name", { ascending: true })
        .limit(1);

      const filtered = establishmentIdFromUrl
        ? base.eq("id", establishmentIdFromUrl)
        : base;

      const { data, error } = await filtered.maybeSingle();

      if (!error) {
        return buildSnapshot(data as EstablishmentSubscriptionRow | null, false);
      }

      const missingSubscriptionColumns =
        /subscription_status|trial_ends_at|plan_id/i.test(error.message ?? "");

      if (!missingSubscriptionColumns) {
        // Erro genérico (rede, RLS, tabela ausente): avisa sem bloquear.
        return {
          ...EMPTY_SNAPSHOT,
          isActive: true,
          error: LOAD_ERROR,
        };
      }

      // Colunas novas ainda não existem: lê o básico e libera o painel.
      const legacyBase = supabase
        .from("establishments")
        .select(LEGACY_COLUMNS)
        .order("name", { ascending: true })
        .limit(1);

      const legacyFiltered = establishmentIdFromUrl
        ? legacyBase.eq("id", establishmentIdFromUrl)
        : legacyBase;

      const { data: legacyData } = await legacyFiltered.maybeSingle();

      return buildSnapshot(
        legacyData as EstablishmentSubscriptionRow | null,
        true
      );
    }, [supabase, establishmentIdFromUrl]);

  useEffect(() => {
    if (!currentUser) return;

    let cancelled = false;

    fetchSubscription()
      .then((next) => {
        if (cancelled) return;
        setSnapshot((prev) => (isSameSnapshot(prev, next) ? prev : next));
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = { ...EMPTY_SNAPSHOT, isActive: true, error: LOAD_ERROR };
        setSnapshot((prev) => (isSameSnapshot(prev, fallback) ? prev : fallback));
      });

    return () => {
      cancelled = true;
    };
  }, [currentUser, fetchSubscription]);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchSubscription();
      setSnapshot((prev) => (isSameSnapshot(prev, next) ? prev : next));
    } catch {
      const fallback = { ...EMPTY_SNAPSHOT, isActive: true, error: LOAD_ERROR };
      setSnapshot((prev) => (isSameSnapshot(prev, fallback) ? prev : fallback));
    }
  }, [fetchSubscription]);

  const value = useMemo<PanelSubscription>(
    () => ({
      ...(snapshot ?? EMPTY_SNAPSHOT),
      isLoading,
      isSuperAdmin,
      refresh,
    }),
    [snapshot, isLoading, isSuperAdmin, refresh]
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

/** Acesso à situação da assinatura dentro do painel. */
export function useSubscription(): PanelSubscription {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error(
      "useSubscription deve ser usado dentro de SubscriptionProvider."
    );
  }
  return context;
}
