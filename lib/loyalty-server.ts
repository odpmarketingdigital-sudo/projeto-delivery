/**
 * Programa de fidelidade — persistência e regras que dependem do banco.
 *
 * Espelha o padrão de `lib/coupons-server.ts`: `lib/loyalty.ts` permanece puro
 * (compartilhado com o checkout) e aqui ficam as consultas/RPCs usadas pelas
 * rotas de API. Todas as escritas passam pela service role (`createAdminClient`)
 * e usam as funções atômicas da migração 20261118000001
 * (`loyalty_add_points`, `loyalty_redeem_points`, `loyalty_adjust_points`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { roundCurrency } from "@/lib/coupons";
import {
  DEFAULT_LOYALTY_PROGRAM,
  LOYALTY_PHONE_MIN_DIGITS,
  computeLoyaltyRewardDiscount,
  isLoyaltyFreeProductProgram,
  loyaltyMinOrderShortfall,
  loyaltyNextRewardRemaining,
  loyaltyOrdersCycleCount,
  loyaltyOrdersLabel,
  loyaltyOrdersProgressPercent,
  loyaltyOrdersRemaining,
  loyaltyPointsForAmount,
  loyaltyPointsLabel,
  loyaltyProgramRuleLabel,
  loyaltyProgressPercent,
  loyaltyRewardLabel,
  loyaltyRewardsAvailable,
  normalizeLoyaltyPhone,
  normalizeLoyaltyPoints,
  normalizeLoyaltyProgram,
  type LoyaltyAccountRecord,
  type LoyaltyProgram,
  type LoyaltyProgramRecord,
  type LoyaltyRewardMode,
} from "@/lib/loyalty";

/** Dica exibida quando a migração do programa ainda não foi executada. */
export const LOYALTY_SETUP_HINT =
  "O programa de fidelidade ainda não está disponível no banco. Execute as migrações 20261118000001, 20261119000001 e 20261121000001 no SQL Editor do Supabase.";

/** `true` quando o erro indica tabela/função ainda inexistente (migração). */
export function isLoyaltySchemaError(
  message: string | null | undefined
): boolean {
  return /does not exist|schema cache|could not find|undefined function/i.test(
    message ?? ""
  );
}

/** Converte numéricos do PostgREST (texto) com segurança. */
function toLoyaltyNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* -------------------------------------------------------------------------- */
/* Configuração do programa                                                    */
/* -------------------------------------------------------------------------- */

/** Produto do prêmio (linha mínima de `public.products`). */
export interface LoyaltyRewardProduct {
  id: string;
  name: string;
  price: number;
  is_active: boolean;
  image_url: string | null;
}

/**
 * Carrega o produto entregue de graça pelo programa.
 *
 * Usado no checkout (nome/imagem), na validação do pedido (produto ativo) e no
 * painel. Nunca lança: produto removido devolve `null` e o programa fica
 * "não pronto" (`isLoyaltyProgramReady`).
 *
 * `establishmentId` (opcional) restringe a busca à loja dona do programa —
 * impede que um id de produto de outra loja seja aceito como prêmio.
 */
export async function fetchLoyaltyRewardProduct(
  admin: SupabaseClient,
  productId: string | null | undefined,
  establishmentId?: string | null
): Promise<LoyaltyRewardProduct | null> {
  const id = typeof productId === "string" ? productId.trim() : "";
  if (!id) return null;

  let query = admin
    .from("products")
    .select("id, name, price, is_active, image_url")
    .eq("id", id);

  const storeId =
    typeof establishmentId === "string" ? establishmentId.trim() : "";
  if (storeId) query = query.eq("establishment_id", storeId);

  const { data, error } = await query.maybeSingle();

  if (error) {
    if (!isLoyaltySchemaError(error.message)) {
      console.error(
        "[loyalty] Falha ao carregar o produto do prêmio:",
        error.message
      );
    }
    return null;
  }
  if (!data) return null;

  const row = data as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    name: typeof row.name === "string" ? row.name : "Produto do cardápio",
    price: toLoyaltyNumber(row.price),
    is_active: row.is_active !== false,
    image_url: typeof row.image_url === "string" ? row.image_url : null,
  };
}

/**
 * Carrega os produtos elegíveis do prêmio (migração 20261121000001).
 *
 * Devolve os produtos na MESMA ordem da lista configurada — o primeiro vira o
 * item pré-selecionado no checkout — e ignora ids inexistentes/duplicados.
 * `establishmentId` restringe a busca à loja dona do programa.
 */
export async function fetchLoyaltyRewardProducts(
  admin: SupabaseClient,
  productIds: string[] | null | undefined,
  establishmentId?: string | null
): Promise<LoyaltyRewardProduct[]> {
  const ids = Array.isArray(productIds)
    ? Array.from(
        new Set(
          productIds
            .map((id) => (typeof id === "string" ? id.trim() : ""))
            .filter(Boolean)
        )
      )
    : [];
  if (ids.length === 0) return [];

  let query = admin
    .from("products")
    .select("id, name, price, is_active, image_url")
    .in("id", ids);

  const storeId =
    typeof establishmentId === "string" ? establishmentId.trim() : "";
  if (storeId) query = query.eq("establishment_id", storeId);

  const { data, error } = await query;

  if (error) {
    if (!isLoyaltySchemaError(error.message)) {
      console.error(
        "[loyalty] Falha ao carregar os produtos do prêmio:",
        error.message
      );
    }
    return [];
  }

  const byId = new Map<string, LoyaltyRewardProduct>();
  for (const row of (Array.isArray(data) ? data : []) as Array<
    Record<string, unknown>
  >) {
    const id = String(row.id ?? "");
    if (!id) continue;
    byId.set(id, {
      id,
      name: typeof row.name === "string" ? row.name : "Produto do cardápio",
      price: toLoyaltyNumber(row.price),
      is_active: row.is_active !== false,
      image_url: typeof row.image_url === "string" ? row.image_url : null,
    });
  }

  return ids
    .map((id) => byId.get(id))
    .filter((product): product is LoyaltyRewardProduct => product != null);
}

/**
 * Carrega a configuração da loja.
 *
 * Nunca lança: loja sem linha (ou base sem a migração) recebe o padrão
 * desligado, mantendo checkout e vitrine intactos. Quando o prêmio é um produto
 * do cardápio, o nome é resolvido aqui para o checkout/WhatsApp exibirem
 * "Pizza Marguerita grátis" em vez do id.
 */
export async function fetchLoyaltyProgram(
  admin: SupabaseClient,
  establishmentId: string | null | undefined
): Promise<LoyaltyProgram> {
  if (!establishmentId) return { ...DEFAULT_LOYALTY_PROGRAM };

  const { data, error } = await admin
    .from("loyalty_programs")
    .select("*")
    .eq("establishment_id", establishmentId)
    .maybeSingle();

  if (error) {
    if (!isLoyaltySchemaError(error.message)) {
      console.error(
        "[loyalty] Falha ao carregar a configuração do programa:",
        error.message
      );
    }
    return { ...DEFAULT_LOYALTY_PROGRAM };
  }

  const program = normalizeLoyaltyProgram(
    (data as LoyaltyProgramRecord | null) ?? null
  );
  if (program.reward_product_ids.length === 0) return program;

  const products = await fetchLoyaltyRewardProducts(
    admin,
    program.reward_product_ids,
    establishmentId
  );
  // Com uma única opção o rótulo fica específico ("Pizza grátis"); com várias,
  // a UI/WhatsApp preferem o texto genérico ("2 produtos grátis").
  if (products.length === 1) program.reward_product_name = products[0].name;
  return program;
}

/** Cria/atualiza a configuração (1:1 por estabelecimento). */
export async function saveLoyaltyProgram(
  admin: SupabaseClient,
  establishmentId: string,
  program: LoyaltyProgram
): Promise<{ program: LoyaltyProgram | null; error: string | null }> {
  const payload = {
    establishment_id: establishmentId,
    enabled: program.enabled,
    reward_mode: program.reward_mode,
    points_per_real: program.points_per_real,
    points_per_reward: program.points_per_reward,
    reward_type: program.reward_type,
    reward_value: program.reward_value,
    min_order_value: program.min_order_value,
    orders_per_reward: program.orders_per_reward,
    // `reward_product_id` continua gravado (primeiro item) para bases/painéis
    // antigos e para a CHECK `loyalty_programs_free_product_required`.
    reward_product_id: program.reward_product_ids[0] ?? null,
    reward_product_ids:
      program.reward_product_ids.length > 0 ? program.reward_product_ids : null,
    reward_product_quantity: program.reward_product_quantity,
  };

  const { data, error } = await admin
    .from("loyalty_programs")
    .upsert(payload, { onConflict: "establishment_id" })
    .select("*")
    .single();

  if (error || !data) {
    return {
      program: null,
      error: isLoyaltySchemaError(error?.message)
        ? LOYALTY_SETUP_HINT
        : (error?.message ?? "Falha ao salvar o programa de fidelidade."),
    };
  }

  const saved = normalizeLoyaltyProgram(data as LoyaltyProgramRecord);
  if (saved.reward_product_ids.length > 0) {
    const products = await fetchLoyaltyRewardProducts(
      admin,
      saved.reward_product_ids,
      establishmentId
    );
    if (products.length === 1) saved.reward_product_name = products[0].name;
  }

  return { program: saved, error: null };
}

/* -------------------------------------------------------------------------- */
/* Saldo por cliente                                                           */
/* -------------------------------------------------------------------------- */

/** Saldo normalizado de um cliente (pronto para a UI e para o checkout). */
export interface LoyaltyAccount {
  phone: string;
  name: string | null;
  balance: number;
  total_earned: number;
  rewards_redeemed: number;
  /** Pedidos finalizados já contabilizados no ciclo (modo por pedidos). */
  orders_count: number;
  /** Prêmios conquistados e ainda não utilizados (modo por pedidos). */
  free_rewards_available: number;
  last_order_id: string | null;
  updated_at: string | null;
}

/** Normaliza uma linha de `customer_loyalty`. */
export function normalizeLoyaltyAccount(
  row?: LoyaltyAccountRecord | null
): LoyaltyAccount | null {
  if (!row) return null;
  const phone = normalizeLoyaltyPhone(row.customer_phone);
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS) return null;

  return {
    phone,
    name: row.customer_name?.trim() || null,
    balance: normalizeLoyaltyPoints(row.points_balance),
    total_earned: normalizeLoyaltyPoints(row.total_earned),
    rewards_redeemed: normalizeLoyaltyPoints(row.rewards_redeemed),
    orders_count: normalizeLoyaltyPoints(row.orders_count),
    free_rewards_available: normalizeLoyaltyPoints(row.free_rewards_available),
    last_order_id: row.last_order_id ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** Saldo do telefone informado (ou `null` quando ainda não participa). */
export async function fetchLoyaltyAccount(
  admin: SupabaseClient,
  establishmentId: string | null | undefined,
  phone: unknown
): Promise<LoyaltyAccount | null> {
  const digits = normalizeLoyaltyPhone(phone);
  if (!establishmentId || digits.length < LOYALTY_PHONE_MIN_DIGITS) {
    return null;
  }

  const { data, error } = await admin
    .from("customer_loyalty")
    .select("*")
    .eq("establishment_id", establishmentId)
    .eq("customer_phone", digits)
    .maybeSingle();

  if (error) {
    if (!isLoyaltySchemaError(error.message)) {
      console.error(
        "[loyalty] Falha ao carregar o saldo do cliente:",
        error.message
      );
    }
    return null;
  }

  return normalizeLoyaltyAccount(data as LoyaltyAccountRecord | null);
}

/** Participantes da loja, do maior saldo para o menor. */
export async function listLoyaltyParticipants(
  admin: SupabaseClient,
  establishmentId: string,
  limit = 200
): Promise<{ participants: LoyaltyAccount[]; error: string | null }> {
  const { data, error } = await admin
    .from("customer_loyalty")
    .select("*")
    .eq("establishment_id", establishmentId)
    .order("points_balance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 500)));

  if (error) {
    return {
      participants: [],
      error: isLoyaltySchemaError(error.message)
        ? LOYALTY_SETUP_HINT
        : error.message,
    };
  }

  const participants = (Array.isArray(data) ? data : [])
    .map((row) => normalizeLoyaltyAccount(row as LoyaltyAccountRecord))
    .filter((row): row is LoyaltyAccount => row !== null);

  return { participants, error: null };
}

/** Movimentação do extrato de pontos. */
export interface LoyaltyTransaction {
  id: string;
  kind: string;
  points: number;
  balance_after: number;
  description: string | null;
  order_id: string | null;
  customer_phone: string;
  created_at: string;
}

/** Extrato do telefone informado (mais recentes primeiro). */
export async function listLoyaltyTransactions(
  admin: SupabaseClient,
  establishmentId: string,
  phone: unknown,
  limit = 50
): Promise<{ transactions: LoyaltyTransaction[]; error: string | null }> {
  const digits = normalizeLoyaltyPhone(phone);
  if (digits.length < LOYALTY_PHONE_MIN_DIGITS) {
    return { transactions: [], error: "Informe um telefone válido com DDD." };
  }

  const { data, error } = await admin
    .from("loyalty_transactions")
    .select("*")
    .eq("establishment_id", establishmentId)
    .eq("customer_phone", digits)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));

  if (error) {
    return {
      transactions: [],
      error: isLoyaltySchemaError(error.message)
        ? LOYALTY_SETUP_HINT
        : error.message,
    };
  }

  const transactions = (Array.isArray(data) ? data : []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id ?? ""),
      kind: String(record.kind ?? ""),
      points: toLoyaltyNumber(record.points),
      balance_after: toLoyaltyNumber(record.balance_after),
      description:
        typeof record.description === "string" ? record.description : null,
      order_id: typeof record.order_id === "string" ? record.order_id : null,
      customer_phone: String(record.customer_phone ?? ""),
      created_at: String(record.created_at ?? ""),
    } satisfies LoyaltyTransaction;
  });

  return { transactions, error: null };
}

/* -------------------------------------------------------------------------- */
/* Movimentações atômicas (RPCs da migração)                                   */
/* -------------------------------------------------------------------------- */

/** Nome de uma das funções SQL de pontos. */
type LoyaltyRpcName =
  | "loyalty_add_points"
  | "loyalty_redeem_points"
  | "loyalty_adjust_points";

/**
 * Executa uma RPC de pontos devolvendo o novo saldo.
 *
 * `null` significa "nada foi movimentado" (cliente sem saldo, telefone
 * inválido ou base sem a migração). A função SQL é a fonte da verdade — o
 * servidor nunca soma pontos no Node.
 */
async function callLoyaltyRpc(
  admin: SupabaseClient,
  fn: LoyaltyRpcName,
  args: Record<string, unknown>,
  label: string
): Promise<number | null> {
  const { data, error } = await admin.rpc(fn, args);

  if (error) {
    if (!isLoyaltySchemaError(error.message)) {
      console.error(`[loyalty] ${label}:`, error.message);
    }
    return null;
  }

  if (data === null || data === undefined) return null;
  const balance = Number(data);
  return Number.isFinite(balance) ? balance : null;
}

export interface AddLoyaltyPointsInput {
  establishmentId: string;
  phone: unknown;
  customerName?: string | null;
  points: number;
  orderId?: string | null;
  /** `earn` (pedido finalizado), `refund` (cancelamento) ou `adjust`. */
  kind?: "earn" | "refund" | "adjust";
  description?: string | null;
}

/** Credita/estorna pontos (idempotente por `(order_id, kind)`). */
export async function addLoyaltyPoints(
  admin: SupabaseClient,
  input: AddLoyaltyPointsInput
): Promise<number | null> {
  const phone = normalizeLoyaltyPhone(input.phone);
  const points = normalizeLoyaltyPoints(input.points);
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS || points <= 0) return null;

  return callLoyaltyRpc(
    admin,
    "loyalty_add_points",
    {
      p_establishment_id: input.establishmentId,
      p_phone: phone,
      p_customer_name: input.customerName?.trim() || null,
      p_points: points,
      p_order_id: input.orderId ?? null,
      p_kind: input.kind ?? "earn",
      p_description: input.description ?? null,
    },
    "falha ao creditar pontos"
  );
}

export interface RedeemLoyaltyPointsInput {
  establishmentId: string;
  phone: unknown;
  points: number;
  orderId?: string | null;
  description?: string | null;
}

/**
 * Debita pontos de um prêmio.
 *
 * Devolve `null` quando o saldo é insuficiente — nesse caso o pedido NÃO pode
 * receber o desconto (o chamador precisa abortar/estornar o pedido).
 */
export async function redeemLoyaltyPoints(
  admin: SupabaseClient,
  input: RedeemLoyaltyPointsInput
): Promise<number | null> {
  const phone = normalizeLoyaltyPhone(input.phone);
  const points = normalizeLoyaltyPoints(input.points);
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS || points <= 0) return null;

  return callLoyaltyRpc(
    admin,
    "loyalty_redeem_points",
    {
      p_establishment_id: input.establishmentId,
      p_phone: phone,
      p_points: points,
      p_order_id: input.orderId ?? null,
      p_description: input.description ?? null,
    },
    "falha ao resgatar pontos"
  );
}

export interface AdjustLoyaltyPointsInput {
  establishmentId: string;
  phone: unknown;
  customerName?: string | null;
  /** Delta em pontos: positivo credita, negativo debita (saldo nunca < 0). */
  delta: number;
  description?: string | null;
}

/** Ajuste manual do painel (`+` credita, `-` debita). */
export async function adjustLoyaltyPoints(
  admin: SupabaseClient,
  input: AdjustLoyaltyPointsInput
): Promise<number | null> {
  const phone = normalizeLoyaltyPhone(input.phone);
  const delta = Math.trunc(Number(input.delta));
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS) return null;
  if (!Number.isFinite(delta) || delta === 0) return null;

  return callLoyaltyRpc(
    admin,
    "loyalty_adjust_points",
    {
      p_establishment_id: input.establishmentId,
      p_phone: phone,
      p_customer_name: input.customerName?.trim() || null,
      p_delta: delta,
      p_description: input.description ?? null,
    },
    "falha ao ajustar pontos"
  );
}

/* -------------------------------------------------------------------------- */
/* Contagem de pedidos e produto grátis (migração 20261119000001)              */
/* -------------------------------------------------------------------------- */

/** Funções SQL que devolvem um objeto `jsonb` com o estado do cliente. */
type LoyaltyOrderRpcName =
  | "loyalty_register_order"
  | "loyalty_revert_order"
  | "loyalty_redeem_free_reward";

/** Executa uma RPC `jsonb` devolvendo o objeto tipado (ou `null`). */
async function callLoyaltyJsonRpc(
  admin: SupabaseClient,
  fn: LoyaltyOrderRpcName,
  args: Record<string, unknown>,
  label: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin.rpc(fn, args);

  if (error) {
    if (!isLoyaltySchemaError(error.message)) {
      console.error(`[loyalty] ${label}:`, error.message);
    }
    return null;
  }

  if (!data || typeof data !== "object") return null;
  return data as Record<string, unknown>;
}

/** Progresso do ciclo de pedidos devolvido pelas RPCs. */
export interface LoyaltyOrderProgress {
  /** Pedidos finalizados contabilizados no ciclo atual. */
  orders_count: number;
  /** Meta do ciclo (`orders_per_reward` no momento da chamada). */
  orders_per_reward: number;
  /** Pedidos que faltam para o próximo prêmio (0 = prêmio disponível). */
  orders_remaining: number;
  /** Prêmios conquistados e ainda não usados. */
  free_rewards_available: number;
  /** `true` quando este pedido fechou o ciclo e liberou um prêmio. */
  reward_unlocked: boolean;
  /** `true` no estorno quando o prêmio usado no pedido voltou ao cliente. */
  reward_returned: boolean;
  /** Saldo de pontos do cliente depois da operação. */
  points_balance: number;
  /** Resgates acumulados (pontos + produtos grátis). */
  rewards_redeemed: number;
}

export interface LoyaltyOrderRpcInput {
  establishmentId: string;
  phone: unknown;
  customerName?: string | null;
  orderId?: string | null;
  ordersPerReward: number;
}

/** Lê o progresso do `jsonb` devolvido pelas RPCs (campos opcionais). */
function readOrderProgress(
  data: Record<string, unknown> | null,
  ordersPerReward: number
): LoyaltyOrderProgress | null {
  if (!data) return null;
  const per = Math.max(1, Math.trunc(Number(ordersPerReward) || 1));
  const ordersCount = normalizeLoyaltyPoints(data.orders_count);
  const freeRewards = normalizeLoyaltyPoints(data.free_rewards_available);
  const cycle = ordersCount % per;

  return {
    orders_count: ordersCount,
    orders_per_reward: per,
    orders_remaining: freeRewards > 0 ? 0 : cycle === 0 ? per : per - cycle,
    free_rewards_available: freeRewards,
    reward_unlocked: data.reward_unlocked === true,
    reward_returned: data.reward_returned === true,
    points_balance: normalizeLoyaltyPoints(data.points_balance),
    rewards_redeemed: normalizeLoyaltyPoints(data.rewards_redeemed),
  };
}

/**
 * Conta 1 pedido finalizado para o cliente.
 *
 * A função SQL é idempotente por pedido (`orders.loyalty_order_counted`), então
 * reabrir/refinalizar não duplica a contagem. `null` = nada foi contabilizado
 * (programa desligado, telefone inválido ou base sem a migração).
 */
export async function registerLoyaltyOrder(
  admin: SupabaseClient,
  input: LoyaltyOrderRpcInput
): Promise<LoyaltyOrderProgress | null> {
  const phone = normalizeLoyaltyPhone(input.phone);
  if (!input.establishmentId || phone.length < LOYALTY_PHONE_MIN_DIGITS) {
    return null;
  }

  const data = await callLoyaltyJsonRpc(
    admin,
    "loyalty_register_order",
    {
      p_establishment_id: input.establishmentId,
      p_phone: phone,
      p_customer_name: input.customerName?.trim() || null,
      p_order_id: input.orderId ?? null,
      p_orders_per_reward: Math.max(1, Math.trunc(input.ordersPerReward) || 1),
    },
    "falha ao contabilizar o pedido no programa de fidelidade"
  );

  return readOrderProgress(data, input.ordersPerReward);
}

/**
 * Desfaz a contagem de um pedido cancelado e devolve o prêmio que ele usou.
 *
 * Idempotente: cancelar duas vezes não altera o saldo (`null` na segunda).
 */
export async function revertLoyaltyOrder(
  admin: SupabaseClient,
  input: LoyaltyOrderRpcInput
): Promise<LoyaltyOrderProgress | null> {
  const phone = normalizeLoyaltyPhone(input.phone);
  if (
    !input.establishmentId ||
    !input.orderId ||
    phone.length < LOYALTY_PHONE_MIN_DIGITS
  ) {
    return null;
  }

  const data = await callLoyaltyJsonRpc(
    admin,
    "loyalty_revert_order",
    {
      p_establishment_id: input.establishmentId,
      p_phone: phone,
      p_order_id: input.orderId,
      p_orders_per_reward: Math.max(1, Math.trunc(input.ordersPerReward) || 1),
    },
    "falha ao estornar a contagem de pedidos"
  );

  return readOrderProgress(data, input.ordersPerReward);
}

export interface RedeemLoyaltyFreeRewardInput {
  establishmentId: string;
  phone: unknown;
  orderId: string;
  /**
   * Produtos escolhidos pelo cliente — 1 item por unidade do prêmio (pode
   * repetir o mesmo produto). O primeiro é gravado também em
   * `orders.loyalty_reward_product_id` (compatibilidade).
   */
  productIds: string[];
  /** Nomes na mesma ordem de `productIds` (histórico/relatórios). */
  productNames?: string[];
  /** Quantidade configurada no programa (informativa; o débito é 1 prêmio). */
  quantity?: number;
  ordersPerReward: number;
}

/**
 * Debita 1 prêmio conquistado e grava no pedido os produtos entregues de graça.
 *
 * `null` = o cliente não tem prêmio disponível (ou base sem a migração); nesse
 * caso o chamador precisa abortar o pedido — nunca entregamos produto grátis
 * sem debitar o prêmio. O débito continua sendo de 1 recompensa por resgate,
 * independentemente de quantos itens o prêmio entrega.
 */
export async function redeemLoyaltyFreeReward(
  admin: SupabaseClient,
  input: RedeemLoyaltyFreeRewardInput
): Promise<LoyaltyOrderProgress | null> {
  const phone = normalizeLoyaltyPhone(input.phone);
  const productIds = Array.isArray(input.productIds)
    ? input.productIds.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0
      )
    : [];
  if (
    !input.establishmentId ||
    !input.orderId ||
    productIds.length === 0 ||
    phone.length < LOYALTY_PHONE_MIN_DIGITS
  ) {
    return null;
  }

  const productNames = Array.isArray(input.productNames)
    ? productIds.map((_, index) => input.productNames?.[index]?.trim() || null)
    : productIds.map(() => null);

  const data = await callLoyaltyJsonRpc(
    admin,
    "loyalty_redeem_free_reward",
    {
      p_establishment_id: input.establishmentId,
      p_phone: phone,
      p_order_id: input.orderId,
      // Assinatura antiga (5 args) continua aceita pela função SQL.
      p_product_id: productIds[0],
      p_product_name: productNames[0],
      p_product_ids: productIds,
      p_product_names: productNames,
      p_quantity: Math.max(1, Math.trunc(input.quantity ?? productIds.length)),
    },
    "falha ao resgatar o produto grátis"
  );

  return readOrderProgress(data, input.ordersPerReward);
}

/* -------------------------------------------------------------------------- */
/* Integração com os pedidos                                                   */
/* -------------------------------------------------------------------------- */

/** Subconjunto de `public.orders` usado no crédito/estorno de pontos. */
export interface LoyaltyOrderRow {
  id: string;
  establishment_id?: string | null;
  customer_phone?: string | null;
  customer_name?: string | null;
  subtotal?: number | string | null;
  coupon_discount?: number | string | null;
  loyalty_discount?: number | string | null;
  total?: number | string | null;
  status?: string | null;
}

/** Código curto do pedido usado nas descrições do extrato. */
function loyaltyOrderCode(orderId: string): string {
  return `#${orderId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** Base de pontos: subtotal pago (sem frete e já descontado). */
export function loyaltyPointsBase(order: LoyaltyOrderRow): number {
  const subtotal = toLoyaltyNumber(order.subtotal);
  const coupon = toLoyaltyNumber(order.coupon_discount);
  const redeemed = toLoyaltyNumber(order.loyalty_discount);
  return roundCurrency(Math.max(0, subtotal - coupon - redeemed));
}

/**
 * Resultado de um crédito/estorno de fidelidade.
 *
 * `reward_mode` informa a regra ativa no momento: por pontos
 * (`points_per_real`/`points_per_reward`) ou por pedidos
 * (`orders_per_reward` → 1 produto grátis do cardápio).
 */
export interface LoyaltyMovementResult {
  reward_mode: LoyaltyRewardMode;
  /** Pontos creditados/devolvidos (0 no modo por pedidos). */
  points: number;
  /** Saldo de pontos após a operação. */
  balance: number;
  /** Progresso do ciclo de pedidos (null no modo por pontos). */
  orders: LoyaltyOrderProgress | null;
}

/**
 * Credita o pedido finalizado.
 *
 * - Modo por pedidos: soma 1 no contador e libera o produto grátis ao fechar o
 *   ciclo (`registerLoyaltyOrder`, idempotente por pedido).
 * - Modo por pontos: credita `loyalty_points_for_amount`; idempotente pela
 *   unique `(order_id, kind)` da função SQL, então reabrir o pedido não duplica.
 */
export async function creditLoyaltyForCompletedOrder(
  admin: SupabaseClient,
  order: LoyaltyOrderRow
): Promise<LoyaltyMovementResult | null> {
  const establishmentId = order.establishment_id ?? "";
  if (!establishmentId) return null;

  const program = await fetchLoyaltyProgram(admin, establishmentId);
  if (!program.enabled) return null;

  const phone = normalizeLoyaltyPhone(order.customer_phone);
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS) return null;

  if (isLoyaltyFreeProductProgram(program)) {
    const orders = await registerLoyaltyOrder(admin, {
      establishmentId,
      phone,
      customerName: order.customer_name ?? null,
      orderId: order.id,
      ordersPerReward: program.orders_per_reward,
    });
    if (!orders) return null;

    return {
      reward_mode: "orders",
      points: 0,
      balance: orders.points_balance,
      orders,
    };
  }

  if (program.reward_mode !== "points") return null;

  const points = loyaltyPointsForAmount(program, loyaltyPointsBase(order));
  if (points <= 0) return null;

  const balance = await addLoyaltyPoints(admin, {
    establishmentId,
    phone,
    customerName: order.customer_name ?? null,
    points,
    orderId: order.id,
    kind: "earn",
    description: `Pontos do pedido ${loyaltyOrderCode(order.id)}`,
  });
  if (balance === null) return null;

  // Registra no pedido o que foi creditado (histórico/relatórios). Bases que
  // ainda não têm a coluna simplesmente ignoram o update.
  const { error: updateError } = await admin
    .from("orders")
    .update({ loyalty_points_earned: points })
    .eq("id", order.id);
  if (updateError && !isLoyaltySchemaError(updateError.message)) {
    console.error(
      "[loyalty] Falha ao gravar loyalty_points_earned no pedido:",
      updateError.message
    );
  }

  return { reward_mode: "points", points, balance, orders: null };
}

/**
 * Estorna a fidelidade de um pedido cancelado.
 *
 * - Modo por pedidos: `revertLoyaltyOrder` desfaz a contagem e devolve o prêmio
 *   consumido por este pedido (idempotente pelo `loyalty_order_counted`).
 * - Modo por pontos: soma o que foi creditado (`earn`) e o que foi resgatado
 *   (`redeem`) em um único `refund` (unique por `(order_id, kind)`); se já
 *   existir um `refund` para o pedido, nada é devolvido novamente.
 */
export async function reverseLoyaltyForCanceledOrder(
  admin: SupabaseClient,
  order: LoyaltyOrderRow
): Promise<LoyaltyMovementResult | null> {
  const establishmentId = order.establishment_id ?? "";
  if (!establishmentId) return null;

  const program = await fetchLoyaltyProgram(admin, establishmentId);
  const orderPhone = normalizeLoyaltyPhone(order.customer_phone);

  if (
    program.enabled &&
    isLoyaltyFreeProductProgram(program) &&
    orderPhone.length >= LOYALTY_PHONE_MIN_DIGITS
  ) {
    const orders = await revertLoyaltyOrder(admin, {
      establishmentId,
      phone: orderPhone,
      orderId: order.id,
      ordersPerReward: program.orders_per_reward,
    });
    if (orders) {
      return {
        reward_mode: "orders",
        points: 0,
        balance: orders.points_balance,
        orders,
      };
    }
  }

  const { data, error } = await admin
    .from("loyalty_transactions")
    .select("kind, points, customer_phone")
    .eq("order_id", order.id);

  if (error) {
    if (!isLoyaltySchemaError(error.message)) {
      console.error(
        "[loyalty] Falha ao carregar as movimentações do pedido:",
        error.message
      );
    }
    return null;
  }

  let refundable = 0;
  let phone = orderPhone;
  for (const row of (Array.isArray(data) ? data : []) as Array<
    Record<string, unknown>
  >) {
    const kind = String(row.kind ?? "");
    const points = toLoyaltyNumber(row.points);
    const rowPhone = normalizeLoyaltyPhone(row.customer_phone);
    if (rowPhone.length >= LOYALTY_PHONE_MIN_DIGITS) phone = rowPhone;
    if (kind === "refund") return null; // já estornado
    if (kind === "earn") refundable += points;
    if (kind === "redeem") refundable += Math.abs(points);
  }

  if (refundable <= 0) return null;
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS) return null;

  const balance = await addLoyaltyPoints(admin, {
    establishmentId,
    phone,
    customerName: order.customer_name ?? null,
    points: refundable,
    orderId: order.id,
    kind: "refund",
    description: `Estorno do pedido ${loyaltyOrderCode(order.id)}`,
  });
  if (balance === null) return null;

  return {
    reward_mode: "points",
    points: refundable,
    balance,
    orders: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Status do cliente (checkout)                                                */
/* -------------------------------------------------------------------------- */

/** Resumo do programa para o checkout e para a API pública. */
export interface LoyaltyStatusPayload {
  enabled: boolean;
  program: LoyaltyProgram;
  phone: string;
  /** Modalidade ativa: por pontos ou por quantidade de pedidos. */
  reward_mode: LoyaltyRewardMode;
  /** Saldo atual (0 quando o cliente ainda não participa). */
  balance: number;
  total_earned: number;
  rewards_redeemed: number;
  /** Prêmios resgatáveis agora (pontos ou ciclos de pedidos completos). */
  rewards_available: number;
  /** Quanto falta para o próximo prêmio (pontos ou pedidos). */
  next_reward_remaining: number;
  progress_percent: number;
  /** Ex.: "R$ 10,00 de desconto" / "Pizza Marguerita grátis". */
  reward_label: string;
  /** Bloqueio de pedido mínimo do resgate (null = liberado). */
  min_order_message: string | null;
  /** Desconto que o resgate aplicaria neste carrinho (0 = não aplicável). */
  reward_discount: number;
  /** Rótulo do que é consumido no resgate (ex.: "100 pontos", "10 pedidos"). */
  points_per_reward_label: string;
  /** `true` quando o prêmio é 1 (ou mais) produto grátis do cardápio. */
  free_product: boolean;
  /**
   * Produto principal do prêmio (primeiro da lista). Mantido por
   * compatibilidade com checkouts antigos; prefira `free_products`.
   */
  free_product_id: string | null;
  free_product_name: string | null;
  /** Preço de cardápio do produto principal (para exibir "de R$ X por R$ 0"). */
  free_product_price: number;
  /**
   * Produtos elegíveis ATIVOS que o cliente pode escolher no resgate. Vazio no
   * modo por pontos ou quando a loja não tem nenhum produto ativo configurado.
   */
  free_products: Array<{ id: string; name: string; price: number }>;
  /** Quantos itens grátis o cliente ganha ao usar 1 prêmio (1 a 10). */
  free_product_quantity: number;
  /** Pedidos contabilizados no ciclo atual (modo por pedidos). */
  orders_count: number;
  /** Meta de pedidos do ciclo (0 no modo por pontos). */
  orders_per_reward: number;
  /** Pedidos que faltam para o próximo prêmio (0 = prêmio disponível). */
  orders_remaining: number;
  /** Ex.: "3 de 10 pedidos". */
  orders_goal_label: string;
  /** Prêmios de produto grátis conquistados e não usados. */
  free_rewards_available: number;
  /** Frase pronta da regra: "A cada 10 pedidos: Pizza grátis". */
  rule_label: string;
}

/**
 * Monta o status do programa para um telefone/carrinho.
 *
 * É usado por `POST /api/loyalty/status` (checkout) — o servidor só faz
 * pré-visualização; o resgate real acontece em `POST /api/orders`.
 *
 * As duas modalidades compartilham os mesmos campos genéricos
 * (`rewards_available`, `next_reward_remaining`, `progress_percent`), então a
 * UI só precisa alternar o rótulo — e os campos `orders_*`/`free_product*`
 * trazem o detalhe do modo por pedidos.
 */
export async function buildLoyaltyStatus(
  admin: SupabaseClient,
  params: {
    establishmentId: string;
    phone: unknown;
    subtotal: number;
    deliveryFee?: number | null;
  }
): Promise<LoyaltyStatusPayload> {
  const program = await fetchLoyaltyProgram(admin, params.establishmentId);
  const phone = normalizeLoyaltyPhone(params.phone);
  const account =
    phone.length >= LOYALTY_PHONE_MIN_DIGITS
      ? await fetchLoyaltyAccount(admin, params.establishmentId, phone)
      : null;

  const enabled = program.enabled;
  const ordersMode = enabled && isLoyaltyFreeProductProgram(program);
  const balance = account?.balance ?? 0;
  const ordersCount = account?.orders_count ?? 0;
  const freeRewards = account?.free_rewards_available ?? 0;

  const rewardProducts =
    ordersMode && program.reward_product_ids.length > 0
      ? await fetchLoyaltyRewardProducts(
          admin,
          program.reward_product_ids,
          params.establishmentId
        )
      : [];
  // O checkout só oferece produtos ativos: item pausado não pode virar prêmio.
  const activeRewardProducts = rewardProducts.filter(
    (product) => product.is_active
  );
  const primaryRewardProduct = activeRewardProducts[0] ?? null;

  return {
    enabled,
    program,
    phone,
    reward_mode: program.reward_mode,
    balance,
    total_earned: account?.total_earned ?? 0,
    rewards_redeemed: account?.rewards_redeemed ?? 0,
    rewards_available: enabled
      ? ordersMode
        ? freeRewards
        : loyaltyRewardsAvailable(program, balance)
      : 0,
    next_reward_remaining: enabled
      ? ordersMode
        ? loyaltyOrdersRemaining(program, ordersCount, freeRewards)
        : loyaltyNextRewardRemaining(program, balance)
      : 0,
    progress_percent: enabled
      ? ordersMode
        ? loyaltyOrdersProgressPercent(program, ordersCount)
        : loyaltyProgressPercent(program, balance)
      : 0,
    reward_label: loyaltyRewardLabel(program),
    min_order_message: enabled
      ? loyaltyMinOrderShortfall(program, params.subtotal)
      : null,
    reward_discount: enabled
      ? computeLoyaltyRewardDiscount(program, {
          subtotal: params.subtotal,
          deliveryFee: params.deliveryFee ?? 0,
        })
      : 0,
    points_per_reward_label: ordersMode
      ? loyaltyOrdersLabel(program.orders_per_reward)
      : loyaltyPointsLabel(program.points_per_reward),
    free_product: ordersMode,
    // Sem produto resolvido/ativo o resgate fica bloqueado no checkout (o
    // servidor também recusa o pedido) — o painel avisa para reconfigurar.
    free_product_id: ordersMode ? (primaryRewardProduct?.id ?? null) : null,
    free_product_name: ordersMode
      ? (primaryRewardProduct?.name ?? program.reward_product_name)
      : null,
    free_product_price: primaryRewardProduct?.price ?? 0,
    free_products: ordersMode
      ? activeRewardProducts.map((product) => ({
          id: product.id,
          name: product.name,
          price: product.price,
        }))
      : [],
    free_product_quantity: ordersMode ? program.reward_product_quantity : 0,
    orders_count: ordersMode ? ordersCount : 0,
    orders_per_reward: ordersMode ? program.orders_per_reward : 0,
    orders_remaining: ordersMode
      ? loyaltyOrdersRemaining(program, ordersCount, freeRewards)
      : 0,
    orders_goal_label: ordersMode
      ? `${loyaltyOrdersCycleCount(program, ordersCount)} de ${loyaltyOrdersLabel(
          program.orders_per_reward
        )}`
      : "",
    free_rewards_available: ordersMode ? freeRewards : 0,
    rule_label: loyaltyProgramRuleLabel(program),
  };
}
