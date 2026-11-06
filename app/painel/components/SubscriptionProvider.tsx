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
  isBillingCycleId,
  isSubscriptionActive,
  type BillingCycleId,
  type SubscriptionStatus,
} from "@/lib/subscriptions";
import {
  getDaysOverdue,
  OVERDUE_GRACE_DAYS,
  resolveBillingDueDate,
} from "@/lib/storeEligibility";

/**
 * Colunas de assinatura lidas do estabelecimento selecionado.
 * A RLS (`establishments_select_own` / `establishments_select_super_admin`)
 * garante que o admin só enxerga a própria loja.
 */
const SUBSCRIPTION_COLUMNS =
  "id, name, status, subscription_status, trial_ends_at, plan_id";

/**
 * Colunas de ciclo/renovação (migração 20261110000019). São lidas junto das
 * demais; quando ainda não existem, a leitura cai para `SUBSCRIPTION_COLUMNS`.
 */
const CYCLE_COLUMNS = `${SUBSCRIPTION_COLUMNS}, subscription_cycle, subscription_expires_at`;

/**
 * Colunas de cobrança/inadimplência (migração 20261110000023): permitem ao
 * painel avisar sobre o atraso e linkar a fatura no Asaas.
 */
const OVERDUE_COLUMNS = `${CYCLE_COLUMNS}, payment_due_date, payment_invoice_url, overdue_suspended_at`;

/** Colunas mínimas usadas quando a migração de assinaturas ainda não rodou. */
const LEGACY_COLUMNS = "id, name";

/**
 * Ordem de recuo quando uma migração ainda não rodou. O último conjunto é o
 * mínimo aceitável (base legada, sem nenhuma coluna de assinatura).
 */
const COLUMN_SETS = [
  OVERDUE_COLUMNS,
  CYCLE_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  LEGACY_COLUMNS,
] as const;

/** Erro do PostgREST indicando coluna ausente (migração pendente). */
const MISSING_COLUMN_PATTERN =
  /subscription_status|trial_ends_at|plan_id|subscription_cycle|subscription_expires_at|payment_due_date|payment_invoice_url|overdue_suspended_at/i;

/** Mensagem única para falhas de leitura (exibida na tela de assinatura). */
const LOAD_ERROR = "Não foi possível carregar a situação da sua assinatura.";

/** Linha lida de `establishments` (só o que o painel precisa). */
interface EstablishmentSubscriptionRow {
  id: string;
  name: string | null;
  /** `ativo` | `inativo` (coluna `status`, sempre existente). */
  status?: string | null;
  subscription_status?: SubscriptionStatus | null;
  trial_ends_at?: string | null;
  plan_id?: string | null;
  subscription_cycle?: string | null;
  subscription_expires_at?: string | null;
  /** Vencimento da fatura em aberto (migração 20261110000023). */
  payment_due_date?: string | null;
  /** Link da fatura no Asaas para o banner de regularização. */
  payment_invoice_url?: string | null;
  /** Momento da suspensão automática por atraso. */
  overdue_suspended_at?: string | null;
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
  /** Ciclo contratado (null quando desconhecido ou base legada). */
  cycle: BillingCycleId | null;
  /** Fim do período pago / próxima renovação (`YYYY-MM-DD`). */
  expiresAt: string | null;
  /** Dias restantes de trial (0 quando não é trial ou já expirou). */
  daysRemaining: number;
  /** Resultado de `isSubscriptionActive` para a loja de referência. */
  isActive: boolean;
  /** `ativo` | `inativo` (suspensão manual ou automática por atraso). */
  storeStatus: "ativo" | "inativo";
  /** Data de referência do atraso (`YYYY-MM-DD`), quando houver. */
  paymentDueDate: string | null;
  /** Link da fatura no Asaas (banner de regularização). */
  paymentInvoiceUrl: string | null;
  /** Momento da suspensão automática por atraso (null quando não suspensa). */
  overdueSuspendedAt: string | null;
  /** Dias corridos de atraso (0 quando em dia). */
  daysOverdue: number;
  /** `true` quando o atraso passou da carência de 15 dias. */
  isOverdue: boolean;
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
  cycle: null,
  expiresAt: null,
  daysRemaining: 0,
  isActive: true,
  storeStatus: "ativo",
  paymentDueDate: null,
  paymentInvoiceUrl: null,
  overdueSuspendedAt: null,
  daysOverdue: 0,
  isOverdue: false,
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
  const rawCycle = row.subscription_cycle ?? null;
  const now = new Date();

  /**
   * Inadimplência: a contagem usa o vencimento da fatura em aberto (ou o fim do
   * período pago, quando posterior) — ver `lib/storeEligibility.ts`.
   */
  const paymentDueDate = resolveBillingDueDate({
    subscription_status: status,
    trial_ends_at: trialEndsAt,
    subscription_expires_at: row.subscription_expires_at ?? null,
    payment_due_date: row.payment_due_date ?? null,
  });
  const daysOverdue = paymentDueDate ? getDaysOverdue(paymentDueDate, now) : 0;

  return {
    establishmentId: row.id,
    establishmentName: row.name,
    status,
    trialEndsAt,
    planId: row.plan_id ?? null,
    cycle: isBillingCycleId(rawCycle) ? rawCycle : null,
    expiresAt: row.subscription_expires_at ?? null,
    daysRemaining:
      status === "trialing" ? getTrialDaysRemaining(trialEndsAt, now) : 0,
    isActive: isSubscriptionActive(
      { subscription_status: status, trial_ends_at: trialEndsAt },
      now
    ),
    storeStatus: row.status === "inativo" ? "inativo" : "ativo",
    paymentDueDate,
    paymentInvoiceUrl: row.payment_invoice_url ?? null,
    overdueSuspendedAt: row.overdue_suspended_at ?? null,
    daysOverdue,
    isOverdue: daysOverdue > OVERDUE_GRACE_DAYS,
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
 *  1. `super_admin`: `?establishment_id=` na URL (deep-link de "Acessar
 *     Painel"), validado pela RLS `establishments_select_super_admin`;
 *  2. caso contrário, a primeira loja devolvida pela RLS — para um admin é a
 *     própria loja (`establishments_select_own`).
 *
 * Um admin **nunca** escolhe a loja pela URL: um `?establishment_id=` antigo
 * (link salvo, histórico, deep-link de outra conta) devolveria "loja não
 * encontrada" e mandaria o dono autenticado para o paywall da própria tela de
 * assinatura. A loja dele vem da sessão, no servidor ou pela RLS.
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
    a.cycle === b.cycle &&
    a.expiresAt === b.expiresAt &&
    a.daysRemaining === b.daysRemaining &&
    a.isActive === b.isActive &&
    a.storeStatus === b.storeStatus &&
    a.paymentDueDate === b.paymentDueDate &&
    a.paymentInvoiceUrl === b.paymentInvoiceUrl &&
    a.overdueSuspendedAt === b.overdueSuspendedAt &&
    a.daysOverdue === b.daysOverdue &&
    a.isOverdue === b.isOverdue &&
    a.error === b.error &&
    a.isSchemaPending === b.isSchemaPending &&
    a.isSuperAdmin === b.isSuperAdmin
  );
}

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  // Deep-link de loja é recurso do super admin (o admin só enxerga a própria
  // loja pela RLS). Lido uma única vez por usuário: o id chega na primeira
  // navegação e é preservado nas trocas de tela.
  const establishmentIdFromUrl = useMemo(() => {
    if (typeof window === "undefined" || !currentUser) return null;
    if (currentUser.role !== "super_admin") return null;
    return new URLSearchParams(window.location.search).get("establishment_id");
  }, [currentUser]);

  const [snapshot, setSnapshot] = useState<SubscriptionSnapshot | null>(null);
  // Deriva o loading da ausência de leitura: evita `setState` sincrono no
  // efeito (regra react-hooks/set-state-in-effect) e mantém o painel em
  // "Verificando assinatura..." até a primeira resposta.
  const isLoading = snapshot === null;

  const fetchSubscription =
    useCallback(async (): Promise<SubscriptionSnapshot> => {
      const select = (columns: string) => {
        const base = supabase
          .from("establishments")
          .select(columns)
          .order("name", { ascending: true })
          .limit(1);

        return establishmentIdFromUrl
          ? base.eq("id", establishmentIdFromUrl)
          : base;
      };

      /**
       * Leitura com recuo por migração pendente:
       * cobrança (23) → ciclo (19) → assinatura (12) → base legada.
       * O último conjunto é o modo legado (`isSchemaPending`), que libera o
       * acesso em vez de travar o painel.
       */
      let lastMessage = "";

      for (const [index, columns] of COLUMN_SETS.entries()) {
        const result = await select(columns).maybeSingle();

        if (!result.error) {
          return buildSnapshot(
            result.data as EstablishmentSubscriptionRow | null,
            index === COLUMN_SETS.length - 1
          );
        }

        lastMessage = result.error.message ?? "";

        // Erro genérico (rede, RLS, tabela ausente): avisa sem bloquear.
        if (!MISSING_COLUMN_PATTERN.test(lastMessage)) {
          return { ...EMPTY_SNAPSHOT, isActive: true, error: LOAD_ERROR };
        }
      }

      console.error(
        "[SubscriptionProvider] falha ao ler a assinatura da loja",
        lastMessage
      );
      return { ...EMPTY_SNAPSHOT, isActive: true, error: LOAD_ERROR };
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
