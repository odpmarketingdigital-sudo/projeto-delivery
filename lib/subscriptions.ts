/**
 * Assinaturas e trial (SaaS de autoatendimento).
 *
 * Fonte única dos valores persistidos em `establishments`:
 *  - `trial_ends_at`       → fim dos 30 dias grátis
 *  - `subscription_status` → estado da assinatura
 *  - `subscription_id` / `customer_payment_id` / `plan_id` → gateway/plano
 *
 * Módulo isomórfico (sem APIs de navegador/servidor): usado pela rota de
 * cadastro (`/api/signup`) e pelos componentes que exibem o trial.
 */

/** Duração do período de teste grátis, em dias. */
export const TRIAL_DAYS = 30;

/** Valores aceitos em `establishments.subscription_status` (espelha o CHECK). */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Type guard para valores vindos do cliente/banco. */
export function isSubscriptionStatus(
  value: unknown
): value is SubscriptionStatus {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Dias concedidos ao ativar manualmente uma assinatura pelo Super Admin
 * (pagamento por Pix direto, dinheiro ou cortesia).
 */
export const MANUAL_ACTIVATION_DAYS = 30;

/** Dias do atalho "+15 dias de trial" usado na tela de assinantes. */
export const TRIAL_EXTENSION_DAYS = 15;

/** Limite de segurança para prorrogações manuais de trial. */
export const MAX_TRIAL_EXTENSION_DAYS = 365;

/** Campos de assinatura de um estabelecimento. */
export interface SubscriptionFields {
  /** Fim do trial em ISO 8601 (coluna `trial_ends_at`). */
  trial_ends_at: string | null;
  subscription_status: SubscriptionStatus;
  /** ID da assinatura no gateway (null enquanto não houver cobrança). */
  subscription_id: string | null;
  /** ID do cliente no gateway. */
  customer_payment_id: string | null;
  /** Plano contratado. */
  plan_id: string | null;
  /**
   * Ciclo contratado (`monthly` | `semiannual` | `annual`).
   * Coluna `subscription_cycle` (migração 20261110000019); ausente em bases
   * legadas — nesse caso a tela cai no ciclo informado pelo gateway.
   */
  subscription_cycle?: BillingCycleId | null;
  /**
   * Fim do período pago / próxima renovação (`YYYY-MM-DD`).
   * Coluna `subscription_expires_at` (migração 20261110000019).
   */
  subscription_expires_at?: string | null;
}

/**
 * Data de término do trial em ISO 8601, `TRIAL_DAYS` à frente de `from`.
 * Centraliza o cálculo para que API e testes usem a mesma regra.
 */
export function addTrialDays(
  from: Date = new Date(),
  days: number = TRIAL_DAYS
): string {
  const end = new Date(from.getTime());
  end.setUTCDate(end.getUTCDate() + days);
  return end.toISOString();
}

/** Milissegundos de um dia — base do cálculo de dias restantes. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Nova data de expiração somando `days` a partir do MAIOR valor entre a data
 * atual e `now`.
 *
 * Regra usada pelas ações manuais do Super Admin ("Ativar" e "+15 dias"):
 * nunca encurta uma data futura já paga/trial em andamento e nunca conta a
 * partir de uma data já vencida (o prazo recomeça hoje). Devolve ISO 8601.
 */
export function extendSubscriptionDate(
  current: string | Date | null | undefined,
  days: number,
  now: Date = new Date()
): string {
  const parsed = current ? new Date(current) : null;
  const currentDate =
    parsed && Number.isFinite(parsed.getTime()) ? parsed : null;

  const base =
    currentDate && currentDate.getTime() > now.getTime()
      ? new Date(currentDate.getTime())
      : new Date(now.getTime());

  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
}

/**
 * Dias restantes de trial em relação a `now`.
 *
 * Arredonda para CIMA (um trial que termina em 5h ainda mostra "1 dia") e
 * devolve `0` quando já expirou ou quando a data é inválida/ausente. Valores
 * negativos nunca são retornados — o banner não deve exibir "-3 dias".
 */
export function getTrialDaysRemaining(
  trialEndsAt: string | Date | null | undefined,
  now: Date = new Date()
): number {
  if (!trialEndsAt) return 0;

  const end =
    trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  const endMs = end.getTime();
  if (!Number.isFinite(endMs)) return 0;

  const diff = endMs - now.getTime();
  if (diff <= 0) return 0;

  return Math.ceil(diff / DAY_MS);
}

/** Campos mínimos para decidir se a loja pode usar o painel. */
export type SubscriptionCheckTarget = Pick<
  SubscriptionFields,
  "subscription_status" | "trial_ends_at"
>;

/**
 * Regra única de acesso ao painel (usada pelo guard e pela tela de assinatura).
 *
 * - `active`                      → sempre liberado;
 * - `trialing` com trial no futuro → liberado;
 * - `trialing` com trial vencido   → bloqueado;
 * - `past_due` / `canceled`        → bloqueado.
 *
 * Qualquer outro valor (status desconhecido, linha ausente) é tratado como
 * bloqueado: é mais seguro pedir uma assinatura do que liberar de graça.
 */
export function isSubscriptionActive(
  establishment: SubscriptionCheckTarget | null | undefined,
  now: Date = new Date()
): boolean {
  if (!establishment) return false;

  switch (establishment.subscription_status) {
    case "active":
      return true;
    case "trialing":
      return getTrialDaysRemaining(establishment.trial_ends_at, now) > 0;
    case "past_due":
    case "canceled":
      return false;
    default:
      return false;
  }
}

/** Rótulos curtos de status para badges, banners e tela de assinatura. */
export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Período de Testes",
  // `active` é dinâmico (mensal, semestral ou anual): a tela de assinatura usa
  // `getSubscriptionStatusLabel` para montar o rótulo com o ciclo contratado.
  active: "Plano Ativo",
  past_due: "Pagamento Pendente",
  canceled: "Assinatura Cancelada",
};

/**
 * Rotas do painel liberadas mesmo com a assinatura inválida.
 *
 * `assinatura` é onde o bloqueio manda o usuário; `configuracoes` fica aberta
 * para que ele consiga revisar/atualizar os dados da loja (e o próprio
 * cadastro) mesmo sem plano — decisão de produto da Etapa 2.
 */
export const PAYWALL_BYPASS_PREFIXES = [
  "/painel/assinatura",
  "/painel/configuracoes",
] as const;

/**
 * `true` quando a rota pode ser acessada sem assinatura ativa.
 * Compara por prefixo de segmento (`/painel/configuracoes/x` também passa).
 */
export function isPaywallBypassRoute(
  pathname: string | null | undefined
): boolean {
  if (!pathname) return false;

  return PAYWALL_BYPASS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/** Forma de pagamento exibida no card do plano. */
export interface PlanPaymentMethod {
  /** Nome da forma de pagamento (ex.: "Pix"). */
  label: string;
  /** Observação curta (ex.: "Liberação imediata"). */
  note?: string;
}

/** Plano vendido no autoatendimento (Etapa 3 liga este card ao Asaas). */
export interface SubscriptionPlan {
  id: string;
  name: string;
  tagline: string;
  /** Valor mensal em centavos (evita erros de ponto flutuante). */
  priceCents: number;
  /** Valor mensal já formatado em BRL (ex.: "R$ 97,00"). */
  priceLabel: string;
  /** Período da cobrança (ex.: "mês"). */
  period: string;
  features: string[];
  paymentMethods: PlanPaymentMethod[];
}

/**
 * Valor padrão do Plano Profissional (R$ 97,00/mês).
 * Usado como fallback quando `system_settings.monthly_plan_price` não existe
 * (migração 20261110000013 pendente) ou está inválido.
 */
export const DEFAULT_PLAN_PRICE_CENTS = 9700;

/** Preço mínimo aceito na configuração global (R$ 1,00). */
export const MIN_PLAN_PRICE_CENTS = 100;

/** Preço máximo aceito na configuração global (R$ 10.000,00). */
export const MAX_PLAN_PRICE_CENTS = 1_000_000;

/** `true` quando o valor em centavos é um preço de plano aceitável. */
export function isValidPlanPriceCents(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_PLAN_PRICE_CENTS &&
    value <= MAX_PLAN_PRICE_CENTS
  );
}


/**
 * Valor do plano configurável por ambiente (`NEXT_PUBLIC_PLAN_PRICE_CENTS`,
 * em centavos). Inválido/ausente cai no padrão de R$ 97,00.
 */
export const PLAN_PRICE_CENTS = (() => {
  const raw = process.env.NEXT_PUBLIC_PLAN_PRICE_CENTS;
  if (!raw) return DEFAULT_PLAN_PRICE_CENTS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PLAN_PRICE_CENTS;
})();

/** Formata centavos como moeda brasileira (ex.: 9700 → "R$ 97,00"). */
export function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

/**
 * Formata centavos para edição em um input (sem símbolo): 9700 → "97,00".
 * O valor usa vírgula como separador decimal (padrão pt-BR).
 */
export function formatCentsInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/**
 * Converte o texto digitado no formulário (reais) em centavos.
 *
 * Aceita "97", "97,00", "97.00", "R$ 97,00" e "1.234,56". O último ponto ou
 * vírgula é tratado como separador decimal e os anteriores como milhar.
 * Retorna `null` para texto vazio, zero, negativo ou não numérico.
 */
export function parseBRLToCents(input: string): number | null {
  const cleaned = input.replace(/[^\d,.]/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);

  let normalized = cleaned;
  if (decimalIndex >= 0) {
    const decimals = cleaned.slice(decimalIndex + 1);
    const integerPart = cleaned.slice(0, decimalIndex).replace(/[.,]/g, "");
    if (!/^\d*$/.test(decimals)) return null;
    normalized = `${integerPart || "0"}.${decimals}`;
  }

  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const cents = Math.round(amount * 100);
  return cents > 0 ? cents : null;
}

/**
 * Monta o plano vendido no autoatendimento a partir do preço em centavos.
 *
 * Mantém os textos (nome, recursos, formas de pagamento) em um único lugar,
 * variando apenas o valor — que vem de `system_settings` (lib/settings.ts).
 */
export function buildSubscriptionPlan(priceCents: number): SubscriptionPlan {
  return {
    id: "pro",
    name: "Plano Profissional Ipepper",
    tagline:
      "Tudo o que o seu delivery precisa para vender e organizar a operação.",
    priceCents,
    priceLabel: formatBRL(priceCents),
    period: "mês",
    features: [
      "Pedidos ilimitados no WhatsApp",
      "Cardápio Digital com Fotos",
      "Gestão de Estoque",
      "Impressão Térmica",
      "Cupons de Desconto",
      "Painel e Dashboard completo",
    ],
    paymentMethods: [
      { label: "Pix", note: "Liberação imediata" },
      { label: "Cartão de Crédito", note: "Mensal recorrente" },
      { label: "Boleto", note: "Compensação em até 2 dias úteis" },
    ],
  };
}

/**
 * Plano Profissional Ipepper com o preço padrão/ambiente.
 *
 * Serve de fallback para telas e rotas que não conseguiram ler a configuração
 * global — o valor efetivamente cobrado vem de `getSubscriptionPlan()`
 * (lib/settings.ts).
 */
export const IPEPPER_PRO_PLAN: SubscriptionPlan =
  buildSubscriptionPlan(PLAN_PRICE_CENTS);

// ---------------------------------------------------------------------------
// Ciclos de cobrança (mensal, semestral e anual)
// ---------------------------------------------------------------------------

/**
 * Ciclos vendidos no autoatendimento.
 *
 * - `id`          → valor usado nas rotas (`cycle`) e no navegador;
 * - `asaasCycle`  → enum aceito pelo `POST /subscriptions` do Asaas;
 * - `months`/`discountPercent` → base do cálculo do total do período.
 *
 * Semestral e anual são UMA assinatura com ciclo maior (o Asaas gera uma
 * cobrança por período). O desconto é aplicado sobre o valor do período, e a
 * tela de assinatura mostra o equivalente mensal para facilitar a comparação.
 */
export const BILLING_CYCLES = [
  {
    id: "monthly",
    label: "Mensal",
    months: 1,
    discountPercent: 0,
    asaasCycle: "MONTHLY",
    periodLabel: "mês",
  },
  {
    id: "semiannual",
    label: "Semestral",
    months: 6,
    discountPercent: 5,
    asaasCycle: "SEMIANNUAL",
    periodLabel: "semestre",
  },
  {
    id: "annual",
    label: "Anual",
    months: 12,
    discountPercent: 10,
    asaasCycle: "YEARLY",
    periodLabel: "ano",
  },
] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];
export type BillingCycleId = BillingCycle["id"];
export type AsaasSubscriptionCycle = BillingCycle["asaasCycle"];

/** Type guard para valores vindos do cliente. */
export function isBillingCycleId(value: unknown): value is BillingCycleId {
  return (
    typeof value === "string" &&
    BILLING_CYCLES.some((cycle) => cycle.id === value)
  );
}

/** Ciclo pelo id (mensal quando o valor é desconhecido). */
export function getBillingCycle(
  id: string | null | undefined
): BillingCycle {
  return BILLING_CYCLES.find((cycle) => cycle.id === id) ?? BILLING_CYCLES[0];
}

/** Valores de um ciclo já calculados (tudo em centavos + rótulos prontos). */
export interface BillingCyclePrice {
  id: BillingCycleId;
  label: string;
  months: number;
  discountPercent: number;
  asaasCycle: AsaasSubscriptionCycle;
  periodLabel: string;
  /** Duração legível do período (ex.: "6 meses"). */
  durationLabel: string;
  /** Valor mensal do plano (sem desconto), em centavos. */
  monthlyCents: number;
  /** Total do período sem desconto, em centavos. */
  listCents: number;
  listLabel: string;
  /** Desconto do ciclo, em centavos. */
  discountCents: number;
  /** Texto do desconto (ex.: "R$ 29,10 (5%)"); vazio no mensal. */
  discountLabel: string;
  /** Total cobrado no período, em centavos. */
  totalCents: number;
  totalLabel: string;
  /** Equivalente mensal do total (para comparar os ciclos). */
  monthlyEquivalentCents: number;
  monthlyEquivalentLabel: string;
}

/**
 * Calcula os valores de um ciclo a partir do preço mensal (centavos).
 *
 * O desconto é arredondado para o centavo mais próximo, e o total nunca é
 * menor que zero.
 */
export function computeBillingCyclePrice(
  monthlyCents: number,
  id: BillingCycleId = "monthly"
): BillingCyclePrice {
  const cycle = getBillingCycle(id);
  const monthly =
    Number.isFinite(monthlyCents) && monthlyCents > 0
      ? Math.round(monthlyCents)
      : 0;

  const listCents = monthly * cycle.months;
  const discountCents =
    cycle.discountPercent > 0
      ? Math.round((listCents * cycle.discountPercent) / 100)
      : 0;
  const totalCents = Math.max(0, listCents - discountCents);
  const monthlyEquivalentCents = Math.round(totalCents / cycle.months);

  const durationLabel =
    cycle.months === 1 ? "1 mês" : `${cycle.months} meses`;

  return {
    id: cycle.id,
    label: cycle.label,
    months: cycle.months,
    discountPercent: cycle.discountPercent,
    asaasCycle: cycle.asaasCycle,
    periodLabel: cycle.periodLabel,
    durationLabel,
    monthlyCents: monthly,
    listCents,
    listLabel: formatBRL(listCents),
    discountCents,
    discountLabel:
      discountCents > 0
        ? `${formatBRL(discountCents)} (${cycle.discountPercent}%)`
        : "",
    totalCents,
    totalLabel: formatBRL(totalCents),
    monthlyEquivalentCents,
    monthlyEquivalentLabel: formatBRL(monthlyEquivalentCents),
  };
}

/** Todos os ciclos com os valores calculados (usado na tela de assinatura). */
export function buildBillingCyclePrices(
  monthlyCents: number
): BillingCyclePrice[] {
  return BILLING_CYCLES.map((cycle) =>
    computeBillingCyclePrice(monthlyCents, cycle.id)
  );
}

// ---------------------------------------------------------------------------
// Ciclo contratado, renovação e datas exibidas no painel
// ---------------------------------------------------------------------------

/** Rótulos do ciclo contratado (ex.: "Plano Anual Ativo"). */
export const SUBSCRIPTION_CYCLE_LABELS: Record<BillingCycleId, string> = {
  monthly: "Mensal",
  semiannual: "Semestral",
  annual: "Anual",
};

/**
 * Converte o `cycle` do Asaas (`MONTHLY` | `SEMIANNUAL` | `YEARLY`) no id
 * interno do ciclo. Valores desconhecidos viram `null` (não presumimos ciclo).
 */
export function asaasCycleToBillingCycleId(
  cycle: string | null | undefined
): BillingCycleId | null {
  switch ((cycle ?? "").trim().toUpperCase()) {
    case "MONTHLY":
      return "monthly";
    case "SEMIANNUAL":
      return "semiannual";
    case "YEARLY":
      return "annual";
    default:
      return null;
  }
}

/**
 * Rótulo do status considerando o ciclo contratado.
 *
 * `active` vira "Plano Mensal Ativo", "Plano Semestral Ativo" ou
 * "Plano Anual Ativo"; sem ciclo conhecido mantém o rótulo genérico
 * ("Plano Ativo"). Os demais status usam o rótulo fixo.
 */
export function getSubscriptionStatusLabel(
  status: SubscriptionStatus,
  cycle: BillingCycleId | string | null | undefined
): string {
  if (status !== "active") return SUBSCRIPTION_STATUS_LABELS[status];
  if (!isBillingCycleId(cycle)) return SUBSCRIPTION_STATUS_LABELS.active;

  return `Plano ${SUBSCRIPTION_CYCLE_LABELS[cycle]} Ativo`;
}

/** Data de hoje (`YYYY-MM-DD`) no fuso de Brasília. */
export function todayDateOnly(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Soma meses a uma data `YYYY-MM-DD` sem deslocamento de fuso.
 * Datas inválidas são devolvidas como recebidas.
 */
export function addMonthsToDateOnly(dateOnly: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly.trim());
  if (!match) return dateOnly;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const base = new Date(Date.UTC(year, month, 1));
  base.setUTCMonth(base.getUTCMonth() + Math.trunc(months));

  // Mantém o dia quando possível (31/01 + 1 mês → 28/02).
  const lastDay = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)
  ).getUTCDate();
  base.setUTCDate(Math.min(day, lastDay));

  return base.toISOString().slice(0, 10);
}

/**
 * Próxima renovação a partir do vencimento devolvido pelo gateway.
 *
 * O `nextDueDate` do Asaas é a data da próxima cobrança: enquanto a cobrança do
 * período atual não é paga ele aponta para hoje — nesse caso a renovação é o
 * fim do período contratado (`nextDueDate + months`). Quando já aponta para o
 * futuro (cobrança do ciclo atual liquidada), ele mesmo é a renovação.
 */
export function resolveRenewalDate(
  nextDueDate: string | null | undefined,
  months: number,
  today: string = todayDateOnly()
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((nextDueDate ?? "").trim());
  if (!match) return null;

  const dueDate = match[0];
  return dueDate > today ? dueDate : addMonthsToDateOnly(dueDate, months);
}

/**
 * Formata uma data para `DD/MM/AAAA`.
 *
 * Aceita `YYYY-MM-DD` (vencimentos do Asaas e colunas `date`) e ISO 8601
 * completo (timestamps do Supabase). Strings só com data NÃO passam por `Date`
 * para não deslocar o dia pelo fuso do navegador/servidor.
 */
export function formatDateBR(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;

  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return null;

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

