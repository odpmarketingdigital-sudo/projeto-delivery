/**
 * Programa de fidelidade (pontos por estabelecimento).
 *
 * Módulo isomórfico: usado no painel (`/painel/fidelidade`), no checkout e nas
 * rotas de API. Nenhuma função aqui acessa o banco — a persistência fica em
 * `lib/loyalty-server.ts` e a fonte da verdade continua sendo `POST /api/orders`
 * (o checkout apenas pré-visualiza o desconto).
 */

import { formatCouponBRL, roundCurrency } from "@/lib/coupons";

/** Tipos de prêmio aceitos por `loyalty_programs.reward_type`. */
export type LoyaltyRewardType =
  | "fixed_discount"
  | "percentage_discount"
  | "free_shipping"
  | "free_product";

export const LOYALTY_REWARD_TYPES: LoyaltyRewardType[] = [
  "fixed_discount",
  "percentage_discount",
  "free_shipping",
  "free_product",
];

export const LOYALTY_REWARD_TYPE_LABELS: Record<LoyaltyRewardType, string> = {
  fixed_discount: "Desconto em R$",
  percentage_discount: "Desconto em %",
  free_shipping: "Frete grátis",
  free_product: "Produto grátis do cardápio",
};

/**
 * Como o cliente acumula o prêmio:
 * - `points` → pontos por real gasto (modelo original);
 * - `orders` → quantidade de pedidos finalizados (premia com produto grátis).
 */
export type LoyaltyRewardMode = "points" | "orders";

export const LOYALTY_REWARD_MODES: LoyaltyRewardMode[] = ["points", "orders"];

export const LOYALTY_REWARD_MODE_LABELS: Record<LoyaltyRewardMode, string> = {
  points: "Pontos por valor gasto",
  orders: "Quantidade de pedidos",
};

export const LOYALTY_REWARD_MODE_HINTS: Record<LoyaltyRewardMode, string> = {
  points:
    "O cliente ganha pontos a cada R$ gasto e troca por desconto, frete grátis ou produto.",
  orders:
    "O cliente acumula 1 ponto de contagem por pedido finalizado e, ao fechar o ciclo, ganha um produto grátis do cardápio.",
};

/** Configuração normalizada do programa (números prontos para uso). */
export interface LoyaltyProgram {
  enabled: boolean;
  /** Modelo de acúmulo (`points` mantém o comportamento original). */
  reward_mode: LoyaltyRewardMode;
  points_per_real: number;
  points_per_reward: number;
  reward_type: LoyaltyRewardType;
  reward_value: number;
  min_order_value: number;
  /** Pedidos finalizados necessários para 1 prêmio (modo `orders`). */
  orders_per_reward: number;
  /**
   * Produto entregue de graça (modo `orders` / prêmio `free_product`).
   *
   * Mantido por compatibilidade com bases/painéis antigos: é sempre o primeiro
   * item de `reward_product_ids` (o cliente escolhe entre a lista completa).
   */
  reward_product_id: string | null;
  /** Nome do produto do prêmio (resolvido pelo servidor para exibição). */
  reward_product_name: string | null;
  /**
   * Produtos do cardápio que o cliente pode escolher no resgate (migração
   * 20261121000001). Sempre contém pelo menos 1 item quando o prêmio é
   * `free_product` — legado com apenas `reward_product_id` é migrado em
   * `normalizeLoyaltyProgram`.
   */
  reward_product_ids: string[];
  /** Quantos itens grátis o cliente ganha por prêmio (1 a 10). */
  reward_product_quantity: number;
}

/**
 * Padrão usado quando a loja ainda não configurou o programa (ou quando as
 * migrações ainda não rodaram). `enabled: false` mantém checkout e vitrine
 * intactos.
 */
export const DEFAULT_LOYALTY_PROGRAM: LoyaltyProgram = {
  enabled: false,
  reward_mode: "points",
  points_per_real: 1,
  points_per_reward: 100,
  reward_type: "fixed_discount",
  reward_value: 10,
  min_order_value: 0,
  orders_per_reward: 10,
  reward_product_id: null,
  reward_product_name: null,
  reward_product_ids: [],
  reward_product_quantity: 1,
};

/** Linha de `public.loyalty_programs` (numéricos voltam como texto no PostgREST). */
export interface LoyaltyProgramRecord {
  id?: string;
  establishment_id?: string;
  enabled?: boolean | string | null;
  reward_mode?: string | null;
  points_per_real?: number | string | null;
  points_per_reward?: number | string | null;
  reward_type?: string | null;
  reward_value?: number | string | null;
  min_order_value?: number | string | null;
  orders_per_reward?: number | string | null;
  reward_product_id?: string | null;
  /** Lista de produtos elegíveis (`uuid[]` — PostgREST devolve array). */
  reward_product_ids?: string[] | string | null;
  /** Quantos itens grátis o cliente ganha por prêmio (coluna `integer`). */
  reward_product_quantity?: number | string | null;
  /** Presente quando a consulta faz join com `products(name)`. */
  reward_product_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Linha de `public.customer_loyalty`. */
export interface LoyaltyAccountRecord {
  establishment_id?: string | null;
  customer_phone: string;
  customer_name?: string | null;
  points_balance?: number | string | null;
  total_earned?: number | string | null;
  rewards_redeemed?: number | string | null;
  /** Pedidos finalizados no ciclo atual (modo `orders`). */
  orders_count?: number | string | null;
  /** Prêmios conquistados e ainda não utilizados (modo `orders`). */
  free_rewards_available?: number | string | null;
  last_order_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Telefone brasileiro com DDD: abaixo disso não há como identificar o cliente. */
export const LOYALTY_PHONE_MIN_DIGITS = 10;
export const LOYALTY_MAX_POINTS_PER_REAL = 100;
export const LOYALTY_MAX_POINTS_PER_REWARD = 100_000;
export const LOYALTY_MAX_REWARD_VALUE = 10_000;
/** Limite do ciclo de pedidos (evita configuração absurda no painel). */
export const LOYALTY_MAX_ORDERS_PER_REWARD = 1000;
/**
 * Quantos itens grátis o cliente pode ganhar em um único resgate. O mesmo teto
 * está na CHECK `loyalty_programs_reward_product_quantity_valid`.
 */
export const LOYALTY_MAX_REWARD_PRODUCT_QUANTITY = 10;
/**
 * Teto de produtos elegíveis por prêmio — limita o payload do painel e as
 * consultas ao cardápio (a tela do lojista filtra por busca).
 */
export const LOYALTY_MAX_REWARD_PRODUCTS = 30;

/** Telefone somente dígitos (mesmo formato de `orders.customer_phone`). */
export function normalizeLoyaltyPhone(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replace(/\D/g, "");
  }
  return "";
}

/** Inteiro não negativo (pontos). */
export function normalizeLoyaltyPoints(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

/** Valor monetário/percentual não negativo, arredondado em centavos. */
export function normalizeLoyaltyAmount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return roundCurrency(parsed);
}

/** Tipo de prêmio válido (fallback: desconto em R$). */
export function normalizeLoyaltyRewardType(value: unknown): LoyaltyRewardType {
  return typeof value === "string" &&
    (LOYALTY_REWARD_TYPES as string[]).includes(value)
    ? (value as LoyaltyRewardType)
    : "fixed_discount";
}

/** Modo de acúmulo válido (fallback: pontos por valor gasto). */
export function normalizeLoyaltyRewardMode(value: unknown): LoyaltyRewardMode {
  return typeof value === "string" &&
    (LOYALTY_REWARD_MODES as string[]).includes(value)
    ? (value as LoyaltyRewardMode)
    : "points";
}

/** UUID simples (o produto do prêmio vem do cardápio do estabelecimento). */
export function normalizeLoyaltyProductId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[0-9a-fA-F-]{32,36}$/.test(trimmed) ? trimmed : null;
}

/** Texto curto vindo do banco (nome do produto do prêmio). */
export function normalizeLoyaltyProductName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Lê um array de UUIDs vindo do PostgREST.
 *
 * Aceita array JS (formato normal), a representação literal do Postgres
 * (`{uuid,uuid}`) e JSON em texto — assim a mesma normalização serve para o
 * formulário, para o banco e para integrações que serializam de formas
 * diferentes.
 */
function parseLoyaltyProductIdArray(value: string): unknown[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.replace(/^"+|"+$/g, "").trim())
      .filter(Boolean);
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Lista de produtos elegíveis do prêmio.
 *
 * Garante compatibilidade retroativa: quando a loja só tem o antigo
 * `reward_product_id`, ele vira o único item da lista. A ordem é preservada
 * (o primeiro vira o produto "principal" do programa) e não há duplicados.
 */
export function normalizeLoyaltyProductIds(
  value: unknown,
  fallbackId?: unknown
): string[] {
  const source: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? parseLoyaltyProductIdArray(value)
      : [];

  const ids: string[] = [];
  for (const entry of source) {
    const id = normalizeLoyaltyProductId(entry);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= LOYALTY_MAX_REWARD_PRODUCTS) break;
  }

  if (ids.length === 0) {
    const legacy = normalizeLoyaltyProductId(fallbackId);
    if (legacy) ids.push(legacy);
  }

  return ids;
}

/** Quantidade de itens grátis por prêmio (mínimo 1, máximo 10). */
export function normalizeLoyaltyProductQuantity(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Math.trunc(parsed), LOYALTY_MAX_REWARD_PRODUCT_QUANTITY);
}

/**
 * Normaliza a configuração vinda do banco/formulário.
 *
 * Nunca devolve `null`: uma loja sem linha na tabela cai no padrão desligado e
 * os limites evitam valores absurdos que quebrariam o cálculo do pedido.
 */
export function normalizeLoyaltyProgram(
  row?: LoyaltyProgramRecord | null
): LoyaltyProgram {
  if (!row) return { ...DEFAULT_LOYALTY_PROGRAM };

  const pointsPerReal = Number(row.points_per_real);
  const pointsPerReward = Number(row.points_per_reward);
  const ordersPerReward = Number(row.orders_per_reward);
  const rewardMode = normalizeLoyaltyRewardMode(row.reward_mode);
  // Compatibilidade: bases antigas só têm `reward_product_id`; a lista é
  // derivada dele e o primeiro item continua sendo o produto "principal".
  const rewardProductIds = normalizeLoyaltyProductIds(
    row.reward_product_ids,
    row.reward_product_id
  );
  const rewardProductId = rewardProductIds[0] ?? null;
  const rewardProductQuantity = normalizeLoyaltyProductQuantity(
    row.reward_product_quantity
  );
  const rewardType =
    rewardMode === "orders"
      ? "free_product"
      : normalizeLoyaltyRewardType(row.reward_type);
  const rewardValue = normalizeLoyaltyAmount(row.reward_value);

  const normalizeCycle = (value: number): number =>
    Number.isFinite(value) && value >= 1
      ? Math.min(Math.trunc(value), LOYALTY_MAX_ORDERS_PER_REWARD)
      : DEFAULT_LOYALTY_PROGRAM.orders_per_reward;

  return {
    enabled: row.enabled === true || row.enabled === "true",
    reward_mode: rewardMode,
    points_per_real:
      Number.isFinite(pointsPerReal) && pointsPerReal > 0
        ? Math.min(pointsPerReal, LOYALTY_MAX_POINTS_PER_REAL)
        : DEFAULT_LOYALTY_PROGRAM.points_per_real,
    points_per_reward:
      Number.isFinite(pointsPerReward) && pointsPerReward >= 1
        ? Math.min(
            Math.trunc(pointsPerReward),
            LOYALTY_MAX_POINTS_PER_REWARD
          )
        : DEFAULT_LOYALTY_PROGRAM.points_per_reward,
    reward_type: rewardType,
    reward_value:
      rewardType === "percentage_discount"
        ? Math.min(rewardValue, 100)
        : rewardType === "free_product"
          ? 0
          : Math.min(rewardValue, LOYALTY_MAX_REWARD_VALUE),
    min_order_value: normalizeLoyaltyAmount(row.min_order_value),
    orders_per_reward: normalizeCycle(ordersPerReward),
    reward_product_id: rewardProductId,
    reward_product_name: normalizeLoyaltyProductName(row.reward_product_name),
    reward_product_ids: rewardProductIds,
    reward_product_quantity: rewardProductQuantity,
  };
}

/**
 * `true` quando o programa premia por quantidade de pedidos com um produto
 * grátis do cardápio (nesse modo não existe desconto em R$).
 */
export function isLoyaltyFreeProductProgram(program: LoyaltyProgram): boolean {
  return program.reward_mode === "orders" || program.reward_type === "free_product";
}

/** `true` quando o prêmio é um produto grátis (exige produto configurado). */
export function isLoyaltyProgramReady(program: LoyaltyProgram): boolean {
  if (!program.enabled) return false;
  if (isLoyaltyFreeProductProgram(program)) {
    // Legado com só `reward_product_id` continua válido: o normalizador
    // replica o id na lista.
    return program.reward_product_ids.length > 0;
  }
  return true;
}

/**
 * Pontos ganhos por um pedido.
 *
 * A base é o subtotal dos itens já com os descontos (cupom e resgate) — o
 * cliente não acumula pontos sobre o frete nem sobre valores que não pagou.
 */
export function loyaltyPointsForAmount(
  program: LoyaltyProgram,
  amount: number
): number {
  if (!program.enabled) return 0;
  // No modo por pedidos o acúmulo é a contagem, não os pontos.
  if (program.reward_mode === "orders") return 0;
  const base = roundCurrency(Number(amount) || 0);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return Math.floor(roundCurrency(base * program.points_per_real));
}

/** Quantos prêmios o saldo atual permite resgatar. */
export function loyaltyRewardsAvailable(
  program: LoyaltyProgram,
  balance: unknown
): number {
  if (program.points_per_reward <= 0) return 0;
  return Math.floor(normalizeLoyaltyPoints(balance) / program.points_per_reward);
}

/** Quanto falta para o próximo prêmio (0 quando já há prêmio disponível). */
export function loyaltyNextRewardRemaining(
  program: LoyaltyProgram,
  balance: unknown
): number {
  if (loyaltyRewardsAvailable(program, balance) > 0) return 0;
  return Math.max(0, program.points_per_reward - normalizeLoyaltyPoints(balance));
}

/** Progresso (%) do ciclo atual em direção ao próximo prêmio. */
export function loyaltyProgressPercent(
  program: LoyaltyProgram,
  balance: unknown
): number {
  if (program.points_per_reward <= 0) return 0;
  const remainder = normalizeLoyaltyPoints(balance) % program.points_per_reward;
  return Math.min(100, Math.round((remainder / program.points_per_reward) * 100));
}

/** Pontos que faltam para completar o próximo prêmio. */
export function loyaltyProgressRemainder(
  program: LoyaltyProgram,
  balance: unknown
): number {
  if (program.points_per_reward <= 0) return 0;
  return normalizeLoyaltyPoints(balance) % program.points_per_reward;
}

/* -------------------------------------------------------------------------- */
/* Modo por quantidade de pedidos                                             */
/* -------------------------------------------------------------------------- */

/** Pedidos dentro do ciclo atual (0 .. orders_per_reward - 1). */
export function loyaltyOrdersCycleCount(
  program: LoyaltyProgram,
  ordersCount: unknown
): number {
  const per = Math.max(1, Math.trunc(program.orders_per_reward) || 1);
  return normalizeLoyaltyPoints(ordersCount) % per;
}

/** "a cada 10 pedidos" — usado no painel, checkout e WhatsApp. */
export function loyaltyOrdersGoalLabel(program: LoyaltyProgram): string {
  const per = Math.max(1, Math.trunc(program.orders_per_reward) || 1);
  return `a cada ${per} ${per === 1 ? "pedido" : "pedidos"}`;
}

/** "1 pedido" / "N pedidos". */
export function loyaltyOrdersLabel(count: unknown): string {
  const safe = normalizeLoyaltyPoints(count);
  return `${safe} ${safe === 1 ? "pedido" : "pedidos"}`;
}

/**
 * Pedidos que faltam para liberar o próximo prêmio. Devolve `0` quando o
 * cliente já tem prêmio disponível (o resgate pode ser feito agora).
 */
export function loyaltyOrdersRemaining(
  program: LoyaltyProgram,
  ordersCount: unknown,
  freeRewards: unknown = 0
): number {
  if (normalizeLoyaltyPoints(freeRewards) > 0) return 0;
  const per = Math.max(1, Math.trunc(program.orders_per_reward) || 1);
  const cycle = loyaltyOrdersCycleCount(program, ordersCount);
  return cycle === 0 ? per : per - cycle;
}

/** Progresso (%) do ciclo de pedidos em direção ao próximo prêmio. */
export function loyaltyOrdersProgressPercent(
  program: LoyaltyProgram,
  ordersCount: unknown
): number {
  const per = Math.max(1, Math.trunc(program.orders_per_reward) || 1);
  const cycle = loyaltyOrdersCycleCount(program, ordersCount);
  return Math.min(100, Math.round((cycle / per) * 100));
}

/**
 * Descrição do prêmio de produto grátis, pronta para o cliente:
 * - 1 item com produto resolvido: `"Pizza Marguerita grátis"`;
 * - 1 item sem produto resolvido: `"1 produto grátis"`;
 * - 2+ itens do mesmo produto: `"2x Pizza Marguerita grátis"`;
 * - 2+ itens com lista de opções: `"2 produtos grátis"`.
 */
export function loyaltyFreeProductLabel(program: LoyaltyProgram): string {
  const quantity = normalizeLoyaltyProductQuantity(
    program.reward_product_quantity
  );

  if (quantity > 1) {
    return program.reward_product_name
      ? `${quantity}x ${program.reward_product_name} grátis`
      : `${quantity} produtos grátis`;
  }

  if (program.reward_product_name) {
    return `${program.reward_product_name} grátis`;
  }
  return "1 produto grátis";
}

export interface LoyaltyDiscountParams {
  subtotal: number;
  /** Taxa de entrega já cotada (0 em retirada ou quando ainda não cotada). */
  deliveryFee?: number | null;
}

/**
 * Desconto do resgate para o pedido atual.
 *
 * Devolve `0` quando o programa está desligado, o carrinho está vazio ou o
 * subtotal não atinge `min_order_value`. O valor nunca ultrapassa o total do
 * pedido (subtotal + frete).
 */
export function computeLoyaltyRewardDiscount(
  program: LoyaltyProgram,
  { subtotal, deliveryFee }: LoyaltyDiscountParams
): number {
  if (!program.enabled) return 0;
  // Produto grátis não vira desconto em R$: o pedido recebe uma linha a 0.
  if (isLoyaltyFreeProductProgram(program)) return 0;

  const safeSubtotal = roundCurrency(Math.max(0, Number(subtotal) || 0));
  const safeDelivery = roundCurrency(Math.max(0, Number(deliveryFee) || 0));
  if (safeSubtotal <= 0) return 0;
  if (program.min_order_value > 0 && safeSubtotal < program.min_order_value) {
    return 0;
  }

  let discount = 0;
  switch (program.reward_type) {
    case "fixed_discount":
      discount = Math.min(program.reward_value, safeSubtotal);
      break;
    case "percentage_discount":
      discount = roundCurrency(
        safeSubtotal *
          (Math.min(Math.max(program.reward_value, 0), 100) / 100)
      );
      break;
    case "free_shipping":
      discount = safeDelivery;
      break;
    case "free_product":
    default:
      discount = 0;
      break;
  }

  return Math.min(
    roundCurrency(discount),
    roundCurrency(safeSubtotal + safeDelivery)
  );
}

/** Percentual formatado no padrão brasileiro (10.5 → "10,5"). */
function formatLoyaltyPercent(value: number): string {
  return Number(value)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1")
    .replace(".", ",");
}

/** Rótulo curto do prêmio (ex.: "R$ 10,00 de desconto", "Frete grátis"). */
export function loyaltyRewardLabel(program: LoyaltyProgram): string {
  switch (program.reward_type) {
    case "percentage_discount":
      return `${formatLoyaltyPercent(program.reward_value)}% de desconto`;
    case "free_shipping":
      return "Frete grátis";
    case "free_product":
      return loyaltyFreeProductLabel(program);
    case "fixed_discount":
    default:
      return `${formatCouponBRL(program.reward_value)} de desconto`;
  }
}

/**
 * Frase completa da regra, para painel/checkout:
 * - pontos: "A cada 100 pontos: R$ 10,00 de desconto";
 * - pedidos: "A cada 10 pedidos: Pizza Marguerita grátis".
 */
export function loyaltyProgramRuleLabel(program: LoyaltyProgram): string {
  if (program.reward_mode === "orders") {
    return `A ${loyaltyOrdersGoalLabel(program)}: ${loyaltyRewardLabel(program)}`;
  }
  return `A cada ${loyaltyPointsLabel(program.points_per_reward)}: ${loyaltyRewardLabel(
    program
  )}`;
}

/** "1 ponto" / "N pontos" (plural correto nas mensagens da UI e do WhatsApp). */
export function loyaltyPointsLabel(points: unknown): string {
  const safe = normalizeLoyaltyPoints(points);
  return `${safe} ${safe === 1 ? "ponto" : "pontos"}`;
}

/**
 * Mensagem de bloqueio quando o subtotal não atinge o mínimo do resgate.
 * `null` quando o resgate é permitido (ou quando não há mínimo configurado).
 */
export function loyaltyMinOrderShortfall(
  program: LoyaltyProgram,
  subtotal: number
): string | null {
  if (program.min_order_value <= 0) return null;
  if ((Number(subtotal) || 0) >= program.min_order_value) return null;
  return `O resgate exige um pedido mínimo de ${formatCouponBRL(
    program.min_order_value
  )}.`;
}
