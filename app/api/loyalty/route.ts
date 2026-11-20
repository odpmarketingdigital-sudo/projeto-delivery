import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  DEFAULT_LOYALTY_PROGRAM,
  LOYALTY_MAX_ORDERS_PER_REWARD,
  LOYALTY_MAX_POINTS_PER_REAL,
  LOYALTY_MAX_POINTS_PER_REWARD,
  LOYALTY_MAX_REWARD_PRODUCT_QUANTITY,
  LOYALTY_MAX_REWARD_VALUE,
  LOYALTY_REWARD_MODES,
  LOYALTY_REWARD_TYPES,
  normalizeLoyaltyProductIds,
  type LoyaltyProgram,
  type LoyaltyRewardMode,
  type LoyaltyRewardType,
} from "@/lib/loyalty";
import {
  fetchLoyaltyProgram,
  fetchLoyaltyRewardProducts,
  listLoyaltyParticipants,
  saveLoyaltyProgram,
} from "@/lib/loyalty-server";

/** Corpo aceito por `PUT /api/loyalty` (snake_case, igual ao banco). */
type LoyaltyProgramPayload = {
  establishment_id?: unknown;
  enabled?: unknown;
  reward_mode?: unknown;
  points_per_real?: unknown;
  points_per_reward?: unknown;
  reward_type?: unknown;
  reward_value?: unknown;
  min_order_value?: unknown;
  orders_per_reward?: unknown;
  reward_product_id?: unknown;
  /** Lista de produtos elegíveis (prioritária sobre `reward_product_id`). */
  reward_product_ids?: unknown;
  /** Quantos itens grátis o cliente ganha por prêmio (1 a 10). */
  reward_product_quantity?: unknown;
};

/** Inteiro positivo dentro do limite (`null` quando inválido). */
function toPositiveInt(value: unknown, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const int = Math.trunc(parsed);
  if (int <= 0 || int > max) return null;
  return int;
}

/** Valor monetário/percentual não negativo (`null` quando inválido). */
function toAmount(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.round(parsed * 100) / 100;
}

/**
 * Inteiro positivo opcional: campo ausente/vazio usa o padrão do programa.
 * Usado pelos campos que só fazem sentido em um dos modos de acúmulo.
 */
function toOptionalPositiveInt(
  value: unknown,
  max: number,
  fallback: number
): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  return toPositiveInt(value, max);
}

/**
 * Valida a configuração enviada pelo painel.
 *
 * As mesmas regras dos `check` da migração 20261118000001 são aplicadas aqui
 * para devolver uma mensagem amigável antes de tocar no banco.
 */
/**
 * Valida a configuração enviada pelo painel.
 *
 * As mesmas regras dos `check` das migrações de fidelidade são aplicadas aqui
 * para devolver uma mensagem amigável antes de tocar no banco. No modo por
 * pedidos (`orders`) o prêmio é sempre um produto grátis do cardápio; os campos
 * de pontos continuam gravados (o banco exige valores > 0), mas não são usados
 * no acúmulo.
 */
function parseLoyaltyProgram(
  body: LoyaltyProgramPayload
): { program: LoyaltyProgram; error: null } | { program: null; error: string } {
  const rawMode =
    typeof body.reward_mode === "string" ? body.reward_mode.trim() : "points";
  if (!LOYALTY_REWARD_MODES.includes(rawMode as LoyaltyRewardMode)) {
    return {
      program: null,
      error:
        "Modo de acúmulo inválido. Use points (por valor gasto) ou orders (por pedidos).",
    };
  }
  const rewardMode = rawMode as LoyaltyRewardMode;
  const ordersMode = rewardMode === "orders";

  const rawType =
    typeof body.reward_type === "string" ? body.reward_type.trim() : "";
  if (
    !ordersMode &&
    !LOYALTY_REWARD_TYPES.includes(rawType as LoyaltyRewardType)
  ) {
    return {
      program: null,
      error:
        "Tipo de prêmio inválido. Use fixed_discount, percentage_discount, free_shipping ou free_product.",
    };
  }
  const rewardType: LoyaltyRewardType = ordersMode
    ? "free_product"
    : (rawType as LoyaltyRewardType);

  const rewardProductIds = normalizeLoyaltyProductIds(
    body.reward_product_ids,
    body.reward_product_id
  );
  if (rewardType === "free_product" && rewardProductIds.length === 0) {
    return {
      program: null,
      error:
        "Escolha ao menos um produto ativo do cardápio que o cliente vai ganhar de graça.",
    };
  }

  const rewardProductQuantity =
    rewardType === "free_product"
      ? toPositiveInt(
          body.reward_product_quantity ?? 1,
          LOYALTY_MAX_REWARD_PRODUCT_QUANTITY
        )
      : 1;
  if (rewardProductQuantity === null) {
    return {
      program: null,
      error: `Informe quantos produtos grátis o cliente ganha por prêmio (1 a ${LOYALTY_MAX_REWARD_PRODUCT_QUANTITY}).`,
    };
  }

  const pointsPerReal = ordersMode
    ? toOptionalPositiveInt(
        body.points_per_real,
        LOYALTY_MAX_POINTS_PER_REAL,
        DEFAULT_LOYALTY_PROGRAM.points_per_real
      )
    : toPositiveInt(body.points_per_real, LOYALTY_MAX_POINTS_PER_REAL);
  if (pointsPerReal === null) {
    return {
      program: null,
      error: `Informe quantos pontos o cliente ganha por real (1 a ${LOYALTY_MAX_POINTS_PER_REAL}).`,
    };
  }

  const pointsPerReward = ordersMode
    ? toOptionalPositiveInt(
        body.points_per_reward,
        LOYALTY_MAX_POINTS_PER_REWARD,
        DEFAULT_LOYALTY_PROGRAM.points_per_reward
      )
    : toPositiveInt(body.points_per_reward, LOYALTY_MAX_POINTS_PER_REWARD);
  if (pointsPerReward === null) {
    return {
      program: null,
      error: `Informe os pontos necessários para o resgate (1 a ${LOYALTY_MAX_POINTS_PER_REWARD}).`,
    };
  }

  const ordersPerReward = ordersMode
    ? toPositiveInt(body.orders_per_reward, LOYALTY_MAX_ORDERS_PER_REWARD)
    : toOptionalPositiveInt(
        body.orders_per_reward,
        LOYALTY_MAX_ORDERS_PER_REWARD,
        DEFAULT_LOYALTY_PROGRAM.orders_per_reward
      );
  if (ordersPerReward === null) {
    return {
      program: null,
      error: `Informe quantos pedidos finalizados valem 1 prêmio (1 a ${LOYALTY_MAX_ORDERS_PER_REWARD}).`,
    };
  }

  const minOrderValue = toAmount(body.min_order_value ?? 0);
  if (minOrderValue === null) {
    return {
      program: null,
      error: "Informe um pedido mínimo válido (0 para não exigir mínimo).",
    };
  }

  let rewardValue = 0;
  if (rewardType !== "free_shipping" && rewardType !== "free_product") {
    const parsedValue = toAmount(body.reward_value ?? 0);
    const max =
      rewardType === "percentage_discount" ? 100 : LOYALTY_MAX_REWARD_VALUE;
    if (parsedValue === null || parsedValue <= 0 || parsedValue > max) {
      return {
        program: null,
        error:
          rewardType === "percentage_discount"
            ? "Informe o percentual do prêmio (maior que 0 e até 100%)."
            : `Informe o valor do prêmio (maior que 0 e até ${LOYALTY_MAX_REWARD_VALUE}).`,
      };
    }
    rewardValue = parsedValue;
  }

  return {
    program: {
      enabled: body.enabled === true,
      reward_mode: rewardMode,
      points_per_real: pointsPerReal,
      points_per_reward: pointsPerReward,
      reward_type: rewardType,
      reward_value: rewardValue,
      min_order_value: minOrderValue,
      orders_per_reward: ordersPerReward,
      reward_product_id: rewardProductIds[0] ?? null,
      reward_product_ids: rewardProductIds,
      reward_product_quantity: rewardProductQuantity,
      reward_product_name: null,
    },
    error: null,
  };
}

/**
 * GET /api/loyalty — configuração do programa + participantes da loja.
 *
 * Devolve `program` (padrão desligado quando a loja ainda não configurou) e a
 * lista de clientes com saldo, ordenada do maior para o menor. Quando a base
 * ainda não tem a migração, `error` traz a dica de setup e a lista vem vazia —
 * o painel continua abrindo para o lojista executar a migração.
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    url.searchParams.get("establishment_id")
  );
  if ("response" in resolved) return resolved.response;
  const establishmentId = resolved.id;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    establishmentId
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso ao programa de fidelidade desta loja." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const program = await fetchLoyaltyProgram(adminClient, establishmentId);
  const { participants, error } = await listLoyaltyParticipants(
    adminClient,
    establishmentId
  );

  return NextResponse.json(
    {
      program,
      participants,
      ...(error ? { error } : {}),
    },
    { status: 200 }
  );
}

/**
 * PUT /api/loyalty — cria/atualiza a configuração do programa.
 *
 * Body: { establishment_id? (super_admin), enabled, reward_mode?, points_per_real?,
 *         points_per_reward?, reward_type, reward_value?, min_order_value?,
 *         orders_per_reward?, reward_product_ids?, reward_product_id? (legado),
 *         reward_product_quantity? }
 *
 * `reward_mode: "orders"` exige `orders_per_reward` e ao menos um produto ativo
 * em `reward_product_ids`; a partir daí o cliente ganha `reward_product_quantity`
 * itens grátis (escolhendo entre os produtos configurados) a cada N pedidos
 * finalizados. `reward_product_id` continua aceito para painéis antigos.
 */
export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: LoyaltyProgramPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    typeof body.establishment_id === "string" ? body.establishment_id : null
  );
  if ("response" in resolved) return resolved.response;
  const establishmentId = resolved.id;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    establishmentId
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode configurar a fidelidade deste estabelecimento." },
      { status: 403 }
    );
  }

  const { program, error: validationError } = parseLoyaltyProgram(body);
  if (!program) {
    return NextResponse.json(
      { error: validationError },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // Os produtos do prêmio precisam existir, ser desta loja e estar ativos —
  // senão o checkout entregaria um item que o cardápio não vende mais.
  if (program.reward_product_ids.length > 0) {
    const rewardProducts = await fetchLoyaltyRewardProducts(
      adminClient,
      program.reward_product_ids,
      establishmentId
    );

    if (rewardProducts.length !== program.reward_product_ids.length) {
      return NextResponse.json(
        {
          error:
            "Um dos produtos escolhidos como prêmio não foi encontrado no cardápio. Atualize a lista e selecione novamente.",
        },
        { status: 400 }
      );
    }

    const inactive = rewardProducts.filter((product) => !product.is_active);
    if (inactive.length > 0) {
      const names = inactive.map((product) => `"${product.name}"`).join(", ");
      return NextResponse.json(
        {
          error:
            inactive.length === 1
              ? `O produto ${names} está desativado no cardápio. Ative-o ou escolha outro prêmio.`
              : `Os produtos ${names} estão desativados no cardápio. Ative-os ou escolha outros prêmios.`,
        },
        { status: 400 }
      );
    }
  }

  const { program: saved, error } = await saveLoyaltyProgram(
    adminClient,
    establishmentId,
    program
  );

  if (error || !saved) {
    return NextResponse.json(
      { error: error ?? "Falha ao salvar o programa de fidelidade." },
      { status: 400 }
    );
  }

  return NextResponse.json({ program: saved }, { status: 200 });
}
