import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { evaluateStoreEligibility } from "@/lib/storeEligibility";
import {
  requireMenuAccess,
  canManageEstablishment,
} from "@/lib/supabase/menuGuard";
import { isStoreOpen } from "@/lib/openingHours";
import { quoteDelivery, type DeliveryQuotePayload } from "@/lib/deliveryQuote";
import { normalizeDeliverySettings } from "@/lib/delivery";
import type { DeliveryDistanceSource } from "@/lib/delivery";
import {
  estimatedDeliveryAtFromNow,
  formatEstimatedDeliveryWindow,
  isValidEstimatedDeliveryWindow,
  type EstimatedDeliveryWindow,
} from "@/lib/deliveryEstimate";
import { dayRange, isValidDateValue } from "@/lib/dateRange";
import {
  computeCouponDiscount,
  couponEligibilityError,
  isValidCouponCode,
  normalizeCouponCode,
  normalizeCouponPhone,
  roundCurrency,
  toCouponNumber,
  type CouponRecord,
} from "@/lib/coupons";
import {
  COUPON_PHONE_MIN_DIGITS,
  customerHasPreviousOrders,
} from "@/lib/coupons-server";
import {
  describeMinOrderShortfall,
  normalizeMinOrderValue,
} from "@/lib/minOrder";
import {
  LOYALTY_PHONE_MIN_DIGITS as LOYALTY_MIN_PHONE_DIGITS,
  computeLoyaltyRewardDiscount,
  isLoyaltyFreeProductProgram,
  loyaltyMinOrderShortfall,
  loyaltyNextRewardRemaining,
  loyaltyOrdersLabel,
  loyaltyOrdersRemaining,
  loyaltyPointsLabel,
  loyaltyRewardLabel,
  normalizeLoyaltyPhone,
  normalizeLoyaltyProductId,
} from "@/lib/loyalty";
import {
  creditLoyaltyForCompletedOrder,
  fetchLoyaltyAccount,
  fetchLoyaltyProgram,
  fetchLoyaltyRewardProducts,
  redeemLoyaltyFreeReward,
  redeemLoyaltyPoints,
  reverseLoyaltyForCanceledOrder,
  type LoyaltyRewardProduct,
} from "@/lib/loyalty-server";
import {
  CARD_PAYMENT_METHOD,
  cardPaymentDetailLabel,
  matchAcceptedCardBrand,
  normalizeCardBrands,
  normalizeCardType,
} from "@/lib/cardBrands";
import {
  MEAL_VOUCHER_PAYMENT_METHOD,
  matchAcceptedMealVoucher,
  mealVoucherPaymentLabel,
  normalizeMealVouchers,
} from "@/lib/mealVouchers";
import { buildStoreOrderWhatsAppUrl } from "@/lib/whatsappOrder";
import {
  fetchOrderNotificationStore,
  notifyOrderStatusChange,
  notifyStoreNewOrder,
  type OrderNotificationLoyaltySummary,
} from "@/lib/whatsapp/orderNotifications";
import { isValidCpfCnpj, onlyDigits } from "@/lib/billing";
import {
  resolveHalfHalfBasePrice,
  toHalfHalfSelection,
  withHalfHalfLabel,
} from "@/lib/halfHalf";
import type { HalfHalfFlavor, HalfHalfSelection } from "@/lib/types";
import {
  normalizeOrderDeliveryType,
  type OrderDeliveryType,
} from "@/lib/orderStatus";

/** Linha de `products` usada no recálculo dos itens do pedido. */
type OrderProductRow = {
  id: string;
  name: string;
  price: number | string;
  is_active: boolean;
  category_id?: string | null;
  /** Coluna nova (migração 20261111000001); ausente em bases legadas. */
  allow_half_half?: boolean | null;
};

/**
 * Status válidos de um pedido — espelha `OrderStatus` (lib/types.ts) e o
 * fluxo do Kanban do painel (PainelPedidos).
 */
const ORDER_STATUSES = [
  "pendente",
  "preparando",
  "entrega",
  "finalizado",
  "cancelado",
] as const;
type OrderStatusValue = (typeof ORDER_STATUSES)[number];

/**
 * Aliases aceitos na borda (query/body): `em_preparo`/`confirmado` →
 * `preparando`, `saiu_para_entrega` → `entrega`, `concluido`/`entregue` →
 * `finalizado`.
 */
const STATUS_ALIASES: Record<string, OrderStatusValue> = {
  em_preparo: "preparando",
  confirmado: "preparando",
  saiu_para_entrega: "entrega",
  concluido: "finalizado",
  entregue: "finalizado",
};

function normalizeOrderStatusValue(value: unknown): OrderStatusValue | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (ORDER_STATUSES.includes(normalized as OrderStatusValue)) {
    return normalized as OrderStatusValue;
  }
  return STATUS_ALIASES[normalized] ?? null;
}

/**
 * GET /api/orders?establishment_id=xxx&status=yyy&date=YYYY-MM-DD
 *
 * Lista os pedidos do estabelecimento (mais recentes primeiro). O `status` e a
 * `date` são opcionais. Quando `date` é informado, filtra pelo dia no fuso da
 * loja (America/Sao_Paulo).
 *
 * Segurança: exige sessão; o requisitante só acessa o próprio estabelecimento
 * (admin) ou qualquer um (super_admin) — ver `canManageEstablishment`.
 *
 * Colunas esperadas em `public.orders`:
 *   id, establishment_id, customer_id?, customer_name?, items (jsonb), total,
 *   status, created_at, updated_at.
 * A listagem usa `select("*")` para tolerar variações do schema padronizado.
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const params = new URL(request.url).searchParams;
  const establishmentId = params.get("establishment_id")?.trim();
  const rawStatus = params.get("status")?.trim() || null;
  const status = rawStatus ? normalizeOrderStatusValue(rawStatus) : null;
  const dateFilter = params.get("date")?.trim() || null;

  if (!establishmentId) {
    return NextResponse.json(
      { error: "Parâmetro establishment_id é obrigatório." },
      { status: 400 }
    );
  }
  if (rawStatus && !status) {
    return NextResponse.json(
      { error: `Status inválido. Use: ${ORDER_STATUSES.join(", ")}.` },
      { status: 400 }
    );
  }
  if (dateFilter && !isValidDateValue(dateFilter)) {
    return NextResponse.json(
      { error: "Data inválida. Use o formato YYYY-MM-DD." },
      { status: 400 }
    );
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    establishmentId
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso aos pedidos deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  let query = adminClient
    .from("orders")
    .select("*")
    .eq("establishment_id", establishmentId);
  if (status) query = query.eq("status", status);
  if (dateFilter) {
    const { startIso, endIso } = dayRange(dateFilter);
    query = query.gte("created_at", startIso).lt("created_at", endIso);
  }

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      {
        error:
          error.message ??
          "Falha ao carregar os pedidos. Verifique se a tabela orders existe.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { orders: data ?? [], date: dateFilter },
    { status: 200 }
  );
}

/**
 * POST /api/orders — cria um pedido vindo do CHECKOUT do cliente.
 *
 * Vitrine pública: NÃO exige sessão (o cliente não tem conta). Todos os
 * valores monetários são RECALCULADOS no servidor a partir de
 * `products`/`addons` — o total do navegador nunca é confiado.
 *
 * Body: {
 *   establishment_id: string,
 *   order_type?: "entrega" | "retirada", // retirada = sem taxa e sem endereço
 *   customer: { name, phone, street, number, neighborhood, complement?, reference? },
 *   payment_method: "pix" | "cartao" | "dinheiro" | "pix_online" | "vale_refeicao",
 *   meal_voucher?: string,      // bandeira do vale (obrigatória em vale_refeicao)
 *   card_type?: "credito" | "debito", // tipo do cartão (migração 20261116000001)
 *   card_brand?: string,        // bandeira do cartão aceita pela loja
 *   customer.document?: string,  // CPF/CNPJ do pagador (PIX Online)
 *   change_for?: number | null,
 *   notes?: string,
 *   coupon_code?: string,
 *   items: [{ productId, quantity, addonIds: string[], halfHalfFlavorIds?: string[], notes? }]
 * }
 *
 * Colunas gravadas em `public.orders` (migration 20261110000006): customer_*
 * , items (jsonb), subtotal, delivery_fee, total, payment_method, change_for,
 * notes, status = 'pendente'.
 */
export async function POST(request: Request) {
  let body: {
    establishment_id?: string;
    slug?: string;
    customer?: {
      name?: string;
      phone?: string;
      street?: string;
      number?: string;
      neighborhood?: string;
      /** Cidade informada/selecionada no autocomplete (opcional). */
      city?: string;
      complement?: string;
      reference?: string;
      /** CEP devolvido pela busca automática de endereço (opcional). */
      cep?: string;
      /** Coordenadas do Places Autocomplete (preferidas para a rota). */
      latitude?: number | string;
      longitude?: number | string;
      /** `place_id` do Google — gravado junto ao endereço. */
      place_id?: string;
      /** CPF/CNPJ do pagador — obrigatório no PIX Online (Asaas). */
      document?: string;
    };
    payment_method?: string;
    /**
     * Modalidade de atendimento escolhida no checkout:
     * `entrega` (padrão) ou `retirada` (balcão, sem taxa e sem endereço).
     * `delivery_type` é aceito como alias para integrações externas.
     */
    order_type?: string;
    delivery_type?: string;
    /** Bandeira do vale-refeição/alimentação (somente `vale_refeicao`). */
    meal_voucher?: string;
    /**
     * Tipo do cartão na entrega (somente `cartao`), migração 20261116000001:
     * `credito` | `debito`. Obrigatório quando a loja cadastrou bandeiras.
     */
    card_type?: string;
    /**
     * Bandeira do cartão aceita pela loja (somente `cartao`). Obrigatória
     * quando a loja cadastrou bandeiras para o tipo escolhido.
     */
    card_brand?: string;
    change_for?: number | null;
    notes?: string;
    /** Código do cupom aplicado no checkout (opcional). */
    coupon_code?: string;
    /**
     * Resgata 1 prêmio de fidelidade neste pedido (migrações 20261118000001,
     * 20261119000001 e 20261121000001). O servidor confere programa ativo,
     * pedido mínimo e o saldo/prêmios do telefone:
     * - modo por pontos: aplica o desconto em R$ e debita os pontos;
     * - modo por pedidos: entrega `reward_product_quantity` itens a R$ 0,00,
     *   escolhidos entre os produtos configurados (ver
     *   `loyalty_reward_product_ids`).
     * O desconto e os produtos NUNCA vêm do navegador — só o sinal e a escolha.
     */
    loyalty_redeem?: boolean;
    /**
     * Produtos escolhidos pelo cliente para o prêmio (modo produto grátis).
     * A quantidade precisa ser exatamente `reward_product_quantity` e cada id
     * precisa estar na lista elegível e ativo no cardápio da loja.
     */
    loyalty_reward_product_ids?: unknown;
    items?: Array<{
      productId?: string;
      quantity?: number;
      addonIds?: string[];
      /**
       * Meio a meio: ids dos 2 sabores escolhidos, sendo um deles o próprio
       * `productId` (item clicado = 1º sabor). Sem este campo o item é uma
       * pizza inteira (1 sabor). A API revalida e recalcula o preço.
       */
      halfHalfFlavorIds?: string[];
      notes?: string;
    }>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  let establishmentId = body.establishment_id?.trim();

  // Se o ID direto vier válido (UUID), usa imediatamente.
  // Caso contrário (nulo, vazio, "__none__" ou formato inválido), deixa como
  // undefined para tentar resolução automática por slug abaixo.
  const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!establishmentId || establishmentId === "__none__" || !UUID_REGEX.test(establishmentId)) {
    establishmentId = undefined;
  }

  const adminClient = createAdminClient();

  // Resolução automática por slug quando o ID direto não está disponível.
  if (!establishmentId) {
    const slugToResolve =
      (typeof body.slug === "string" ? body.slug.trim() : "") ||
      request.headers.get("X-Establishment-Slug")?.trim();

    if (slugToResolve) {
      const { data: estData, error: estError } = await adminClient
        .from("establishments")
        .select("id")
        .ilike("slug", slugToResolve)
        .maybeSingle();

      if (estError) {
        return NextResponse.json(
          {
            error: "Falha ao consultar estabelecimento pelo slug.",
            debug: {
              slug: slugToResolve,
              supabaseError: estError.message ?? String(estError),
              hint: "Verifique se a tabela 'establishments' existe e se a coluna 'slug' está acessível.",
            },
          },
          { status: 500 }
        );
      }

      if (!estData || !estData.id) {
        return NextResponse.json(
          {
            error: `Estabelecimento não encontrado para o slug "${slugToResolve}".`,
            debug: {
              slug: slugToResolve,
              hint: "Confirme se existe um registro em establishments com esse slug.",
            },
          },
          { status: 404 }
        );
      }

      establishmentId = (estData as { id: string }).id;
    }
  }

  // Última validação: só falha se nem o ID direto nem o slug produziram um UUID válido.
  if (!establishmentId || !UUID_REGEX.test(establishmentId)) {
    return NextResponse.json(
      {
        error: "Não foi possível identificar o estabelecimento para este pedido.",
        debug: {
          receivedEstablishmentId: body.establishment_id ?? null,
          receivedSlug: body.slug ?? null,
          headerSlug: request.headers.get("X-Establishment-Slug") ?? null,
        },
      },
      { status: 400 }
    );
  }

  // A loja precisa existir e estar ativa (mesma regra da vitrine). Esse guarda
  // vem antes da validação do carrinho/cliente para que uma loja fora do ar
  // responda 403/404 sem depender do corpo enviado (link ou aba antiga).
  // NOTA: `delivery_fee` pode não existir na tabela em bases legadas —
  // usamos `select("*")` (tolerante) e fallback `?? 0` abaixo, em vez de
  // selecionar a coluna explicitamente (o que lançaria
  // "column establishments.delivery_fee does not exist").
  const { data: establishment, error: establishmentError } = await adminClient
    .from("establishments")
    .select("*")
    .eq("id", establishmentId)
    .maybeSingle();

  if (establishmentError) {
    return NextResponse.json(
      { error: establishmentError.message ?? "Falha ao localizar a loja." },
      { status: 400 }
    );
  }
  if (!establishment) {
    return NextResponse.json(
      { error: "Estabelecimento indisponível no momento." },
      { status: 404 }
    );
  }

  /**
   * Mesma regra da vitrine (`lib/storeEligibility.ts`): loja inativa,
   * assinatura cancelada ou atraso acima de 15 dias impedem o pedido. O
   * `status` continua `ativo` quando quem encerrou a assinatura foi o Asaas
   * (webhook) ou quando a loja entrou em inadimplência.
   */
  const storeEligibility = evaluateStoreEligibility(
    establishment as {
      status?: string | null;
      subscription_status?: string | null;
      trial_ends_at?: string | null;
      subscription_expires_at?: string | null;
      payment_due_date?: string | null;
    }
  );

  if (!storeEligibility.isEligible) {
    if (storeEligibility.reason === "status") {
      return NextResponse.json(
        { error: "Estabelecimento indisponível no momento." },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: "Esta loja não está online no momento." },
      { status: 403 }
    );
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ error: "Seu carrinho está vazio." }, { status: 400 });
  }
  if (rawItems.length > 50) {
    return NextResponse.json(
      { error: "Pedido com número excessivo de itens." },
      { status: 400 }
    );
  }

  const customer = body.customer ?? {};
  const customerName = customer.name?.trim() ?? "";
  const street = customer.street?.trim() ?? "";
  const number = customer.number?.trim() ?? "";
  const neighborhood = customer.neighborhood?.trim() ?? "";

  // Modalidade do pedido: retirada no balcão dispensa endereço e taxa de
  // entrega. `order_type` é o campo do checkout; `delivery_type` é mantido
  // como alias para integrações externas (ambos aceitam `pickup`/`retirada`).
  const orderType: OrderDeliveryType =
    normalizeOrderDeliveryType(body.order_type) ??
    normalizeOrderDeliveryType(body.delivery_type) ??
    "entrega";
  const isPickup = orderType === "retirada";

  if (customerName.length < 3) {
    return NextResponse.json(
      { error: "Informe seu nome completo." },
      { status: 400 }
    );
  }
  if (!isPickup && (!street || !number || !neighborhood)) {
    return NextResponse.json(
      { error: "Informe o endereço de entrega (rua, número e bairro)." },
      { status: 400 }
    );
  }

  const paymentMethod = body.payment_method?.trim() ?? "";
  if (
    !["pix", "cartao", "dinheiro", "pix_online", MEAL_VOUCHER_PAYMENT_METHOD].includes(
      paymentMethod
    )
  ) {
    return NextResponse.json(
      { error: "Selecione a forma de pagamento." },
      { status: 400 }
    );
  }

  // CPF/CNPJ do pagador (somente dígitos) — o Asaas exige o documento para
  // criar o cliente/cobrança do PIX Online. Nas demais formas é ignorado.
  const customerDocument =
    typeof customer.document === "string" ? onlyDigits(customer.document) : "";

  if (paymentMethod === "pix_online") {
    // PIX Online (Split Asaas — migração 20261110000027/28): só aceita quando
    // a loja conectou a subconta, ligou a chave no painel E tem a credencial
    // da subconta salva (necessária para emitir a cobrança com Split).
    const pixStore = establishment as {
      accept_pix_online?: boolean | null;
      asaas_account_id?: string | null;
      asaas_api_key?: string | null;
    };
    const pixOnlineAvailable =
      pixStore.accept_pix_online === true &&
      typeof pixStore.asaas_account_id === "string" &&
      pixStore.asaas_account_id.trim() !== "" &&
      typeof pixStore.asaas_api_key === "string" &&
      pixStore.asaas_api_key.trim() !== "";

    if (!pixOnlineAvailable) {
      return NextResponse.json(
        {
          error:
            "O PIX Online não está disponível nesta loja no momento. " +
            "Escolha outra forma de pagamento.",
        },
        { status: 400 }
      );
    }

    if (!isValidCpfCnpj(customerDocument)) {
      return NextResponse.json(
        {
          error:
            "Informe um CPF/CNPJ válido do pagador para usar o PIX Online.",
        },
        { status: 400 }
      );
    }
  }

  // Vale-Refeição / Alimentação NA ENTREGA (migração 20261111000004).
  //
  // Modalidade presencial (maquininha): NUNCA passa pelo gateway online. A
  // bandeira escolhida é revalidada contra a lista gravada pela loja — o
  // servidor não confia na lista que o navegador exibiu.
  let mealVoucherValue: string | null = null;
  if (paymentMethod === MEAL_VOUCHER_PAYMENT_METHOD) {
    const acceptedMealVouchers = normalizeMealVouchers(
      (establishment as { accepted_meal_vouchers?: unknown })
        .accepted_meal_vouchers
    );
    if (acceptedMealVouchers.length === 0) {
      return NextResponse.json(
        {
          error:
            "Esta loja não aceita vale-refeição/alimentação na entrega. " +
            "Escolha outra forma de pagamento.",
        },
        { status: 400 }
      );
    }

    mealVoucherValue = matchAcceptedMealVoucher(
      acceptedMealVouchers,
      body.meal_voucher
    );
    if (!mealVoucherValue) {
      return NextResponse.json(
        {
          error:
            "Selecione a bandeira do vale-refeição/alimentação aceita pela loja.",
        },
        { status: 400 }
      );
    }
  }

  // Cartão de Crédito / Débito NA ENTREGA (migração 20261116000001).
  //
  // Modalidade presencial (maquininha): NUNCA passa pelo gateway online. Quando
  // a loja cadastrou bandeiras, o tipo e a bandeira escolhidos são revalidados
  // contra as listas gravadas pela loja — o servidor não confia na lista que o
  // navegador exibiu. Loja sem bandeiras cadastradas continua aceitando cartão
  // livremente (comportamento anterior).
  let cardTypeValue: string | null = null;
  let cardBrandValue: string | null = null;
  if (paymentMethod === CARD_PAYMENT_METHOD) {
    const cardStore = establishment as {
      accepted_credit_brands?: unknown;
      accepted_debit_brands?: unknown;
    };
    const creditBrands = normalizeCardBrands(cardStore.accepted_credit_brands);
    const debitBrands = normalizeCardBrands(cardStore.accepted_debit_brands);
    const brandsConfigured = creditBrands.length > 0 || debitBrands.length > 0;

    cardTypeValue = normalizeCardType(body.card_type);

    if (brandsConfigured) {
      if (!cardTypeValue) {
        return NextResponse.json(
          {
            error:
              "Selecione o tipo do cartão (crédito ou débito) para pagar na entrega.",
          },
          { status: 400 }
        );
      }

      const acceptedForType =
        cardTypeValue === "credito" ? creditBrands : debitBrands;
      if (acceptedForType.length === 0) {
        return NextResponse.json(
          {
            error:
              `Esta loja não aceita cartão de ${
                cardTypeValue === "credito" ? "crédito" : "débito"
              } na entrega. Escolha outra forma de pagamento.`,
          },
          { status: 400 }
        );
      }

      cardBrandValue = matchAcceptedCardBrand(
        acceptedForType,
        body.card_brand
      );
      if (!cardBrandValue) {
        return NextResponse.json(
          {
            error:
              "Selecione a bandeira do cartão aceita pela loja para pagar na entrega.",
          },
          { status: 400 }
        );
      }
    }
  }

  // Server-side: bloqueia pedidos fora do horário de funcionamento. Lojas sem
  // horários cadastrados continuam abertas (compatibilidade com bases legadas).
  const storeStatus = isStoreOpen(
    (establishment as { opening_hours?: unknown }).opening_hours
  );
  if (!storeStatus.isOpen) {
    return NextResponse.json(
      {
        error:
          "O estabelecimento está fechado no momento. Não é possível realizar pedidos fora do horário de funcionamento.",
      },
      { status: 400 }
    );
  }

  // Taxa de entrega recalculada no servidor (nunca confia no navegador).
  // `quoteDelivery` usa as coordenadas do Places escolhidas no checkout (ou um
  // geocode que comprove o número), calcula a distância por rota (Google Routes
  // API, com fallback em linha reta) e aplica o modelo da loja (fixo ou por km).
  // Modelo por km sem posição exata: a cotação falha com 422 — nunca cobramos a
  // partir do centroide da rua.
  //
  // Retirada no balcão: não existe entrega, então nenhuma cotação é feita —
  // a taxa é zero e não há validação de raio/endereço.
  let deliveryFee = 0;
  let deliveryQuote: DeliveryQuotePayload | null = null;
  let deliveryDistanceKm: number | null = null;
  let deliveryDurationMinutes: number | null = null;
  let deliveryDistanceSource: DeliveryDistanceSource | null = null;

  if (!isPickup) {
    const deliveryResult = await quoteDelivery(establishment, {
      cep: typeof customer.cep === "string" ? customer.cep : null,
      latitude: customer.latitude,
      longitude: customer.longitude,
      place_id: typeof customer.place_id === "string" ? customer.place_id : null,
      // Sem coordenadas do Places nem CEP, o servidor tenta um geocode exato
      // (número comprovado). Sem isso, a cotação por km falha — não há fallback
      // para centroide de rua.
      address: {
        street,
        number,
        neighborhood,
        city: typeof customer.city === "string" ? customer.city : null,
        cep: typeof customer.cep === "string" ? customer.cep : null,
      },
    });
    if (!deliveryResult.ok) {
      return NextResponse.json(
        { error: deliveryResult.error },
        { status: deliveryResult.status }
      );
    }
    deliveryQuote = deliveryResult.quote;
    deliveryFee = deliveryQuote.fee;
    deliveryDistanceKm = deliveryQuote.distance_km ?? null;
    deliveryDurationMinutes = deliveryQuote.duration_minutes ?? null;
    deliveryDistanceSource = deliveryQuote.distance_source ?? null;

    if (!deliveryQuote.within_radius) {
      const distanceKm = deliveryQuote.distance_km;
      return NextResponse.json(
        {
          error:
            `Endereço fora do raio de entrega da loja` +
            (distanceKm != null
              ? ` (${distanceKm} km de distância, limite de ${deliveryQuote.max_delivery_radius_km} km).`
              : "."),
        },
        { status: 400 }
      );
    }
  }

  // Ids de produtos necessários: itens do pedido + sabores meio a meio (para
  // validar categoria/preço no servidor).
  const productIds = [
    ...new Set(
      rawItems
        .flatMap((item) => [
          item.productId?.trim(),
          ...(Array.isArray(item.halfHalfFlavorIds)
            ? item.halfHalfFlavorIds.map((id) => id.trim())
            : []),
        ])
        .filter((id): id is string => Boolean(id))
    ),
  ];

  // Constrói a consulta de produtos. Aplica `.in("id", ...)` apenas quando há
  // IDs válidos para filtrar — evita passar `"__none__"` (string inválida para
  // coluna uuid) e quebrar a consulta. `allow_half_half` é opcional na base:
  // quando a coluna ainda não existe, a consulta é repetida sem ela.
  const fetchOrderProducts = (fields: string) => {
    const query = adminClient
      .from("products")
      .select(fields)
      .eq("establishment_id", establishmentId);
    return productIds.length > 0 ? query.in("id", productIds) : query;
  };

  let { data: productRows, error: productsError } = await fetchOrderProducts(
    "id, name, price, is_active, category_id, allow_half_half"
  );
  if (productsError && /allow_half_half/i.test(productsError.message ?? "")) {
    ({ data: productRows, error: productsError } = await fetchOrderProducts(
      "id, name, price, is_active, category_id"
    ));
  }

  if (productsError) {
    return NextResponse.json(
      { error: productsError.message ?? "Falha ao carregar os produtos." },
      { status: 400 }
    );
  }

  const productById = new Map(
    ((productRows ?? []) as unknown as OrderProductRow[]).map((row) => [
      row.id,
      row,
    ])
  );

  const allAddonIds = [
    ...new Set(
      rawItems.flatMap((item) =>
        Array.isArray(item.addonIds) ? item.addonIds.filter(Boolean) : []
      )
    ),
  ];

  // Constrói a consulta de adicionais. Aplica `.in("id", ...)` apenas quando há
  // IDs válidos para filtrar — evita passar `"__none__"` (string inválida para
  // coluna uuid) e quebrar a consulta.
  const { data: addonRows, error: addonsError } =
    allAddonIds.length > 0
      ? await adminClient
          .from("addons")
          .select("id, product_id, name, price, is_active")
          .eq("establishment_id", establishmentId)
          .in("id", allAddonIds)
      : await adminClient
          .from("addons")
          .select("id, product_id, name, price, is_active")
          .eq("establishment_id", establishmentId)

  if (addonsError) {
    return NextResponse.json(
      { error: addonsError.message ?? "Falha ao carregar os adicionais." },
      { status: 400 }
    );
  }

  const addonById = new Map(
    ((addonRows ?? []) as Array<{
      id: string;
      product_id: string;
      name: string;
      price: number | string;
      is_active: boolean;
    }>).map((row) => [row.id, row])
  );

  // Recálculo total no servidor (fonte da verdade: products/addons do banco).
  const orderItems: Array<{
    product_id: string;
    name: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    addons: Array<{ id: string; name: string; price: number }>;
    notes?: string;
    half_half?: HalfHalfSelection;
    /** `true` no item entregue de graça pelo programa de fidelidade. */
    loyalty_reward?: boolean;
  }> = [];
  let subtotal = 0;

  for (const item of rawItems) {
    const productId = item.productId?.trim() ?? "";
    const product = productById.get(productId);
    if (!product || !product.is_active) {
      return NextResponse.json(
        { error: "Um dos itens do pedido não está mais disponível." },
        { status: 400 }
      );
    }

    const quantity = Math.floor(Number(item.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99) {
      return NextResponse.json(
        { error: `Quantidade inválida para "${product.name}".` },
        { status: 400 }
      );
    }

    const selectedAddons: Array<{ id: string; name: string; price: number }> = [];
    let addonsPrice = 0;
    const addonIds = Array.isArray(item.addonIds) ? item.addonIds : [];

    for (const addonId of addonIds) {
      const addon = addonById.get(addonId);
      if (!addon || !addon.is_active || addon.product_id !== productId) {
        return NextResponse.json(
          { error: `Adicional inválido para "${product.name}".` },
          { status: 400 }
        );
      }
      const price = Number(addon.price) || 0;
      addonsPrice += price;
      selectedAddons.push({ id: addon.id, name: addon.name, price });
    }

    // Meio a meio: revalida no servidor que o item aceita a divisão, que os 2
    // sabores pertencem à mesma categoria/loja (um deles é o próprio produto)
    // e recalcula o preço pelo sabor mais caro (nunca usa o total enviado pelo
    // navegador). Sem `halfHalfFlavorIds` o item é uma pizza inteira.
    const halfHalfIds = Array.isArray(item.halfHalfFlavorIds)
      ? [
          ...new Set(
            item.halfHalfFlavorIds
              .map((flavorId) => flavorId.trim())
              .filter(Boolean)
          ),
        ]
      : [];

    let displayName = product.name;
    let basePrice = Number(product.price) || 0;
    let halfHalf: HalfHalfSelection | undefined;

    if (halfHalfIds.length > 0) {
      if (product.allow_half_half !== true) {
        return NextResponse.json(
          { error: `O produto "${product.name}" não aceita meio a meio.` },
          { status: 400 }
        );
      }
      if (halfHalfIds.length !== 2) {
        return NextResponse.json(
          { error: `Escolha exatamente 2 sabores para "${product.name}".` },
          { status: 400 }
        );
      }
      if (!halfHalfIds.includes(productId)) {
        return NextResponse.json(
          {
            error: `No meio a meio de "${product.name}", o próprio item deve ser um dos sabores.`,
          },
          { status: 400 }
        );
      }

      // O 1º sabor é sempre o produto do item; a ordem enviada não importa.
      const orderedFlavorIds = [
        productId,
        ...halfHalfIds.filter((flavorId) => flavorId !== productId),
      ];

      const flavors: HalfHalfFlavor[] = [];
      for (const flavorId of orderedFlavorIds) {
        const flavor = productById.get(flavorId);
        if (!flavor || !flavor.is_active) {
          return NextResponse.json(
            {
              error: `Um dos sabores de "${product.name}" não está mais disponível.`,
            },
            { status: 400 }
          );
        }
        if (flavorId !== productId && flavor.allow_half_half !== true) {
          return NextResponse.json(
            {
              error: `O sabor "${flavor.name}" não está habilitado para meio a meio.`,
            },
            { status: 400 }
          );
        }
        if ((flavor.category_id ?? null) !== (product.category_id ?? null)) {
          return NextResponse.json(
            {
              error: `Os sabores de "${product.name}" precisam ser da mesma categoria.`,
            },
            { status: 400 }
          );
        }
        flavors.push({
          id: flavor.id,
          name: flavor.name,
          price: Number(flavor.price) || 0,
        });
      }

      const halfHalfPrice = resolveHalfHalfBasePrice(flavors);
      if (halfHalfPrice == null) {
        return NextResponse.json(
          {
            error: `Um dos sabores de "${product.name}" está sem preço definido. Ajuste o valor no cardápio para vender meio a meio.`,
          },
          { status: 400 }
        );
      }

      basePrice = halfHalfPrice;
      displayName = withHalfHalfLabel(product.name, flavors);
      halfHalf = toHalfHalfSelection(flavors);
    }

    const unitPrice = basePrice + addonsPrice;
    const lineTotal = unitPrice * quantity;
    subtotal += lineTotal;

    orderItems.push({
      product_id: product.id,
      name: displayName,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      addons: selectedAddons,
      ...(halfHalf ? { half_half: halfHalf } : {}),
      ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
    });
  }

  // Taxa de entrega já validada/recalculada acima por `quoteDelivery` (zero em
  // pedidos de retirada no balcão, que não passam pela cotação).

  // Pedido mínimo da loja (`establishments.min_order_value`, migração
  // 20261111000003): compara o SUBTOTAL dos itens (sem a taxa de entrega).
  // O valor do navegador nunca é considerado — a regra vale só para o
  // subtotal recalculado aqui, a partir dos preços do banco.
  const minOrderMessage = describeMinOrderShortfall(
    normalizeMinOrderValue(
      (establishment as { min_order_value?: unknown }).min_order_value
    ),
    subtotal
  );
  if (minOrderMessage) {
    return NextResponse.json({ error: minOrderMessage }, { status: 400 });
  }

  // Cupom de desconto (opcional): SEMPRE revalidado no servidor — o desconto
  // calculado pelo navegador nunca é aceito como fonte da verdade.
  let coupon: CouponRecord | null = null;
  let couponDiscount = 0;
  const requestedCouponCode = normalizeCouponCode(
    typeof body.coupon_code === "string" ? body.coupon_code : ""
  );

  if (requestedCouponCode) {
    if (!isValidCouponCode(requestedCouponCode)) {
      return NextResponse.json(
        { error: "Informe um código de cupom válido." },
        { status: 400 }
      );
    }

    const { data: couponRow, error: couponError } = await adminClient
      .from("coupons")
      .select("*")
      .eq("establishment_id", establishmentId)
      .eq("code", requestedCouponCode)
      .maybeSingle();

    if (couponError) {
      const message = couponError.message ?? "Falha ao validar o cupom.";
      const missingTable = /does not exist|schema cache|could not find/i.test(
        message
      );
      return NextResponse.json(
        {
          error: missingTable
            ? "Cupons indisponíveis no momento. Execute as migrações de cupons (20261110000011 e 20261111000002) no Supabase."
            : message,
        },
        { status: 400 }
      );
    }

    if (!couponRow) {
      return NextResponse.json(
        { error: `Cupom "${requestedCouponCode}" não encontrado nesta loja.` },
        { status: 400 }
      );
    }

    coupon = couponRow as CouponRecord;
    const eligibilityError = couponEligibilityError(coupon, subtotal);
    if (eligibilityError) {
      return NextResponse.json({ error: eligibilityError }, { status: 400 });
    }

    // "Apenas no primeiro pedido": exige telefone e nenhum pedido anterior
    // (cancelados não contam) na mesma loja.
    if (coupon.first_order_only === true) {
      const couponPhone = normalizeCouponPhone(body.customer?.phone);
      if (couponPhone.length < COUPON_PHONE_MIN_DIGITS) {
        return NextResponse.json(
          {
            error:
              "Informe um telefone válido com DDD para usar este cupom de primeiro pedido.",
          },
          { status: 400 }
        );
      }
      const hasPreviousOrders = await customerHasPreviousOrders(adminClient, {
        establishmentId,
        phone: couponPhone,
      });
      if (hasPreviousOrders) {
        return NextResponse.json(
          { error: "Cupom válido apenas para o primeiro pedido." },
          { status: 400 }
        );
      }
    }

    couponDiscount = computeCouponDiscount(
      {
        discount_type: coupon.discount_type,
        discount_value: toCouponNumber(coupon.discount_value),
        min_order_value:
          coupon.min_order_value == null
            ? null
            : toCouponNumber(coupon.min_order_value),
      },
      subtotal,
      deliveryFee
    );

    // Sem desconto efetivo (ex.: frete grátis em pedido com entrega grátis):
    // ignora o cupom para não gravar código nem consumir uso.
    if (couponDiscount <= 0) {
      coupon = null;
      couponDiscount = 0;
    }
  }

  // Programa de fidelidade (opcional): o resgate NUNCA confia no desconto
  // enviado pelo navegador — o servidor recarrega a configuração da loja,
  // confere o pedido mínimo, o saldo do telefone e recalcula o desconto.
  //
  // Os pontos só são debitados depois de o pedido existir (ver `redeemLoyaltyPoints`
  // abaixo), mas o saldo é pré-validado aqui para o cliente não receber um
  // pedido com desconto que não pode pagar em pontos.
  let loyaltyPointsToRedeem = 0;
  let loyaltyDiscount = 0;
  /**
   * Produtos entregues de graça no modo por pedidos, na ordem escolhida pelo
   * cliente (pode repetir o mesmo produto). Vazio no modo por pontos.
   */
  let loyaltyFreeProducts: LoyaltyRewardProduct[] = [];
  /** Ids escolhidos, na ordem — gravados em `orders.loyalty_reward_product_ids`. */
  let loyaltyRewardProductIds: string[] = [];
  /** Quantidade configurada no programa (`reward_product_quantity`). */
  let loyaltyRewardQuantity = 0;
  /** Ciclo de pedidos vigente no momento do resgate (0 no modo por pontos). */
  let loyaltyOrdersPerReward = 0;
  const loyaltyPhone = normalizeLoyaltyPhone(body.customer?.phone);

  if (body.loyalty_redeem === true) {
    const loyaltyProgram = await fetchLoyaltyProgram(adminClient, establishmentId);
    if (!loyaltyProgram.enabled) {
      return NextResponse.json(
        { error: "O programa de fidelidade desta loja não está ativo." },
        { status: 400 }
      );
    }

    // Duas modalidades: por pontos (desconto em R$) e por pedidos (1 produto
    // grátis do cardápio a R$ 0,00 — nunca desconto).
    const ordersMode = isLoyaltyFreeProductProgram(loyaltyProgram);

    if (loyaltyPhone.length < LOYALTY_MIN_PHONE_DIGITS) {
      return NextResponse.json(
        {
          error: ordersMode
            ? "Informe um telefone válido com DDD para usar o prêmio de fidelidade."
            : "Informe um telefone válido com DDD para resgatar pontos de fidelidade.",
        },
        { status: 400 }
      );
    }

    const loyaltyMinOrderMessage = loyaltyMinOrderShortfall(
      loyaltyProgram,
      subtotal
    );
    if (loyaltyMinOrderMessage) {
      return NextResponse.json({ error: loyaltyMinOrderMessage }, { status: 400 });
    }

    if (ordersMode) {
      const rewardQuantity = Math.max(
        1,
        loyaltyProgram.reward_product_quantity
      );
      const eligibleIds = loyaltyProgram.reward_product_ids;

      // Escolhas do cliente: o navegador só envia ids — quantidade, lista
      // elegível e status ativo são revalidados aqui.
      const submittedIds: string[] = [];
      if (Array.isArray(body.loyalty_reward_product_ids)) {
        for (const value of body.loyalty_reward_product_ids) {
          const id = normalizeLoyaltyProductId(value);
          if (id) submittedIds.push(id);
        }
      }
      // Compatibilidade: checkout antigo não envia ids — com 1 produto
      // elegível e quantidade 1 o prêmio continua sendo esse produto.
      const requestedIds =
        submittedIds.length > 0
          ? submittedIds
          : rewardQuantity === 1 && eligibleIds.length === 1
            ? [eligibleIds[0]]
            : [];

      if (requestedIds.length !== rewardQuantity) {
        return NextResponse.json(
          {
            error:
              rewardQuantity === 1
                ? "Escolha 1 produto para usar o prêmio de fidelidade."
                : `Escolha exatamente ${rewardQuantity} produtos para usar o prêmio de fidelidade.`,
          },
          { status: 400 }
        );
      }

      if (requestedIds.some((id) => !eligibleIds.includes(id))) {
        return NextResponse.json(
          {
            error:
              "Um dos produtos escolhidos não faz parte das opções do prêmio de fidelidade. Atualize a página e escolha novamente.",
          },
          { status: 400 }
        );
      }

      // O produto precisa seguir ativo e ser desta loja — o cadastro do painel
      // pode ter mudado entre a escolha no checkout e o envio do pedido.
      const uniqueIds = Array.from(new Set(requestedIds));
      const rewardProductRows = await fetchLoyaltyRewardProducts(
        adminClient,
        uniqueIds,
        establishmentId
      );
      const rewardProductById = new Map(
        rewardProductRows.map((product) => [product.id, product])
      );
      if (
        rewardProductRows.length !== uniqueIds.length ||
        rewardProductRows.some((product) => !product.is_active)
      ) {
        return NextResponse.json(
          {
            error:
              "Um dos produtos do prêmio não está disponível no cardápio agora. Fale com a loja.",
          },
          { status: 400 }
        );
      }

      const loyaltyAccount = await fetchLoyaltyAccount(
        adminClient,
        establishmentId,
        loyaltyPhone
      );
      const freeRewards = loyaltyAccount?.free_rewards_available ?? 0;
      if (freeRewards <= 0) {
        const remaining = loyaltyOrdersRemaining(
          loyaltyProgram,
          loyaltyAccount?.orders_count ?? 0,
          freeRewards
        );
        return NextResponse.json(
          {
            error:
              remaining > 0
                ? `Você ainda não tem um prêmio disponível: faltam ${loyaltyOrdersLabel(
                    remaining
                  )} para o próximo.`
                : "Você ainda não tem um prêmio de fidelidade disponível.",
          },
          { status: 400 }
        );
      }

      loyaltyFreeProducts = requestedIds
        .map((id) => rewardProductById.get(id))
        .filter((product): product is LoyaltyRewardProduct => product != null);
      loyaltyRewardProductIds = requestedIds;
      loyaltyRewardQuantity = rewardQuantity;
      loyaltyOrdersPerReward = loyaltyProgram.orders_per_reward;
    } else {
      const rewardDiscount = computeLoyaltyRewardDiscount(loyaltyProgram, {
        subtotal,
        deliveryFee,
      });
      if (rewardDiscount <= 0) {
        return NextResponse.json(
          { error: "O resgate de fidelidade não gera desconto neste pedido." },
          { status: 400 }
        );
      }

      const loyaltyAccount = await fetchLoyaltyAccount(
        adminClient,
        establishmentId,
        loyaltyPhone
      );
      const loyaltyBalance = loyaltyAccount?.balance ?? 0;
      if (loyaltyBalance < loyaltyProgram.points_per_reward) {
        return NextResponse.json(
          {
            error: `Saldo insuficiente: você tem ${loyaltyPointsLabel(
              loyaltyBalance
            )} e o resgate custa ${loyaltyPointsLabel(
              loyaltyProgram.points_per_reward
            )}.`,
          },
          { status: 400 }
        );
      }

      loyaltyPointsToRedeem = loyaltyProgram.points_per_reward;
      loyaltyDiscount = rewardDiscount;
    }
  }

  const total = Math.max(
    0,
    roundCurrency(subtotal + deliveryFee - couponDiscount - loyaltyDiscount)
  );

  // `change_for` só existe em algumas bases (pode faltar no schema cache).
  // Como as colunas já foram adicionadas no Supabase, enviamos a coluna com
  // fallback seguro: troco válido em dinheiro → número; senão → null.
  const changeForValue =
    paymentMethod === "dinheiro" &&
    typeof body.change_for === "number" &&
    Number.isFinite(body.change_for) &&
    body.change_for > 0
      ? body.change_for
      : null;

  // Validação final de UUID: só rejeita se nem o ID direto nem o slug funcionaram.
  if (!UUID_REGEX.test(establishmentId)) {
    return NextResponse.json(
      { error: "O identificador da loja (establishment_id) é inválido." },
      { status: 400 }
    );
  }

  // Payload do pedido com fallbacks seguros para campos opcionais — nunca
  // enviamos `undefined` (vira ausência) nem objetos/arrays nulos para as
  // colunas jsonb (`customer_address`, `items`).
  //
  // Retirada no balcão: o endereço é gravado vazio de propósito (o painel, as
  // notificações e o rastreio tratam "sem endereço" como retirada). O endereço
  // salvo no perfil do cliente continua intacto para o próximo pedido.
  const addressData = isPickup
    ? {}
    : {
        street,
        number,
        neighborhood,
        // Cidade: usa a do formulário (Places/CEP) e, quando ausente, a
        // resolvida pelo servidor a partir do endereço — o painel sempre tem a
        // cidade preenchida.
        city: customer.city?.trim() || deliveryQuote?.address?.city || "",
        complement: customer.complement?.trim() ?? "",
        reference: customer.reference?.trim() ?? "",
        cep: deliveryQuote?.cep ?? null,
        // Coordenadas efetivamente usadas no cálculo da rota (Places/CEP).
        // Ficam no pedido para o entregador abrir a navegação sem redigitar o
        // endereço.
        ...(deliveryQuote?.destination.latitude != null &&
        deliveryQuote.destination.longitude != null
          ? {
              latitude: deliveryQuote.destination.latitude,
              longitude: deliveryQuote.destination.longitude,
            }
          : {}),
        ...(deliveryQuote?.destination.place_id
          ? { place_id: deliveryQuote.destination.place_id }
          : {}),
      };
  // Resgate no modo por pedidos: cada item do prêmio entra como linha do
  // cardápio a R$ 0,00 (nunca como desconto em R$). Itens repetidos são
  // agrupados em uma linha com `quantity` (2x Pizza vira 1 linha com 2). O
  // subtotal pago não muda — a linha apenas documenta o que deve ser entregue
  // de graça (`loyalty_reward: true`).
  if (loyaltyFreeProducts.length > 0) {
    const groupedRewards = new Map<
      string,
      { product: LoyaltyRewardProduct; quantity: number }
    >();
    for (const product of loyaltyFreeProducts) {
      const entry = groupedRewards.get(product.id);
      if (entry) entry.quantity += 1;
      else groupedRewards.set(product.id, { product, quantity: 1 });
    }

    for (const { product, quantity } of groupedRewards.values()) {
      orderItems.push({
        product_id: product.id,
        name: `${product.name} (prêmio fidelidade)`,
        quantity,
        unit_price: 0,
        line_total: 0,
        addons: [],
        loyalty_reward: true,
      });
    }
  }

  const itemsData = orderItems ?? [];
  const notesValue = body.notes?.trim() || null;

  // Bandeira do vale-refeição/alimentação (migração 20261111000004). Além da
  // coluna estruturada `orders.meal_voucher`, o texto entra nas observações
  // quando a coluna ainda não existe na base — assim o entregador nunca perde
  // a informação de qual maquininha levar.
  const mealVoucherNote = mealVoucherValue
    ? mealVoucherPaymentLabel(mealVoucherValue)
    : null;

  // Tipo/bandeira do cartão (migração 20261116000001). O texto garante que o
  // entregador saiba qual cartão conferir mesmo em bases legadas sem as colunas
  // `orders.card_type`/`orders.card_brand`.
  const cardDetailLabel = cardPaymentDetailLabel(cardTypeValue, cardBrandValue);
  const cardPaymentNote = cardDetailLabel
    ? `Cartão: ${cardDetailLabel}`
    : null;

  // Telefone salvo somente com dígitos (ex.: `17996129158`). A busca em
  // "Meus Pedidos" (/api/orders/customer) normaliza ambos os lados.
  const customerPhoneDigits =
    String(body.customer?.phone ?? "").replace(/\D/g, "") || null;

  // Previsão de entrega configurada pela loja (janela em minutos). O texto
  // fica congelado no pedido e o instante previsto parte da criação.
  const deliverySettings = normalizeDeliverySettings(establishment);
  const estimateWindow: EstimatedDeliveryWindow = {
    min: deliverySettings.estimated_delivery_time_min,
    max: deliverySettings.estimated_delivery_time_max,
  };
  const estimatedDeliveryTime =
    formatEstimatedDeliveryWindow(estimateWindow);
  const estimatedDeliveryAt = estimatedDeliveryAtFromNow(estimateWindow);

  const orderPayload: Record<string, unknown> = {
    establishment_id: establishmentId,
    customer_name: customerName,
    customer_phone: customerPhoneDigits,
    customer_address: addressData ?? {},
    items: itemsData ?? [],
    subtotal: subtotal ?? 0,
    delivery_fee: deliveryFee ?? 0,
    // `total` (canônico) + `total_amount` (alias legado NOT NULL em algumas
    // bases): ambos recebem o total calculado (subtotal + taxa).
    total: total ?? 0,
    total_amount: total ?? 0,
    payment_method: paymentMethod,
    // PIX Online (migração 20261110000028): status inicial do pagamento e o
    // CPF/CNPJ do pagador. Condicional para não gravar colunas que podem não
    // existir quando a loja não usa o recurso (bases legadas).
    ...(paymentMethod === "pix_online"
      ? {
          payment_status: "pendente",
          customer_document: customerDocument || null,
        }
      : {}),
    change_for: changeForValue ?? null,
    // Bandeira do vale na entrega (migração 20261111000004): só é enviada
    // quando a modalidade foi escolhida, para não gravar colunas que podem não
    // existir em bases legadas nas demais formas de pagamento.
    ...(mealVoucherValue ? { meal_voucher: mealVoucherValue } : {}),
    // Tipo/bandeira do cartão na entrega (migração 20261116000001): enviados
    // apenas quando a modalidade foi escolhida, para não gravar colunas que
    // podem não existir em bases legadas nas demais formas de pagamento.
    ...(paymentMethod === CARD_PAYMENT_METHOD && cardTypeValue
      ? { card_type: cardTypeValue }
      : {}),
    ...(paymentMethod === CARD_PAYMENT_METHOD && cardBrandValue
      ? { card_brand: cardBrandValue }
      : {}),
    notes: notesValue ?? null,
    // Modalidade escolhida pelo cliente (migração 20261113000001). O painel usa
    // para exibir "Pronto para buscar" na etapa final de pedidos retirados.
    delivery_type: orderType,
    estimated_delivery_time: estimatedDeliveryTime,
    estimated_delivery_at: estimatedDeliveryAt,
    // Distância/taxa efetivamente cobradas (auditoria e reembolso). A distância
    // é a da rota do Google quando disponível; `delivery_distance_source`
    // registra se veio da rota ou do fallback em linha reta. Pedidos de
    // retirada não têm rota (campos nulos).
    delivery_distance_km: deliveryDistanceKm,
    delivery_duration_minutes: deliveryDurationMinutes,
    delivery_distance_source: deliveryDistanceSource,
    // Colunas de cupom só são enviadas quando um cupom foi aplicado: assim
    // pedidos sem cupom continuam funcionando mesmo em bases que ainda não
    // executaram as migrações de cupons.
    ...(coupon
      ? {
          coupon_id: coupon.id,
          coupon_code: coupon.code,
          coupon_discount: couponDiscount,
          discount_amount: roundCurrency(couponDiscount + loyaltyDiscount),
        }
      : {}),
    // Resgate de fidelidade (migração 20261118000001): gravado apenas quando o
    // resgate foi validado. `discount_amount` (soma cupom + fidelidade) mantém
    // os relatórios existentes corretos nos pedidos só com pontos.
    ...(loyaltyPointsToRedeem > 0
      ? {
          loyalty_points_redeemed: loyaltyPointsToRedeem,
          loyalty_discount: loyaltyDiscount,
          discount_amount: roundCurrency(couponDiscount + loyaltyDiscount),
        }
      : {}),
    status: "pendente",
  };

  let { data: created, error: insertError } = await adminClient
    .from("orders")
    .insert(orderPayload)
    .select("id")
    .single();

  // Base sem a migração 20261113000001: grava o pedido sem a modalidade — o
  // painel volta a inferir entrega/retirada pela presença de endereço.
  if (
    insertError &&
    /delivery_type/i.test(insertError.message ?? "") &&
    /does not exist|could not find|schema cache/i.test(
      insertError.message ?? ""
    )
  ) {
    const retryPayload = { ...orderPayload };
    delete retryPayload.delivery_type;
    ({ data: created, error: insertError } = await adminClient
      .from("orders")
      .insert(retryPayload)
      .select("id")
      .single());
  }

  // Base sem a migração 20261110000015: grava o pedido normalmente, apenas
  // sem a previsão (o restante do fluxo continua funcionando).
  if (
    insertError &&
    /estimated_delivery_time|estimated_delivery_at/i.test(
      insertError.message ?? ""
    ) &&
    /does not exist|could not find|schema cache/i.test(
      insertError.message ?? ""
    )
  ) {
    const retryPayload = { ...orderPayload };
    delete retryPayload.estimated_delivery_time;
    delete retryPayload.estimated_delivery_at;
    ({ data: created, error: insertError } = await adminClient
      .from("orders")
      .insert(retryPayload)
      .select("id")
      .single());
  }

  // Base sem a migração 20261110000024: mantém o pedido (com a taxa já
  // calculada) apenas sem a distância/tempo da rota gravados.
  if (
    insertError &&
    /delivery_distance_km|delivery_duration_minutes|delivery_distance_source/i.test(
      insertError.message ?? ""
    ) &&
    /does not exist|could not find|schema cache/i.test(
      insertError.message ?? ""
    )
  ) {
    const retryPayload = { ...orderPayload };
    delete retryPayload.delivery_distance_km;
    delete retryPayload.delivery_duration_minutes;
    delete retryPayload.delivery_distance_source;
    ({ data: created, error: insertError } = await adminClient
      .from("orders")
      .insert(retryPayload)
      .select("id")
      .single());
  }

  // Base sem a migração 20261111000002: mantém o pedido com o total já
  // descontado, apenas sem a coluna detalhada de desconto.
  if (
    insertError &&
    /discount_amount/i.test(insertError.message ?? "") &&
    /does not exist|could not find|schema cache/i.test(insertError.message ?? "")
  ) {
    const retryPayload = { ...orderPayload };
    delete retryPayload.discount_amount;
    ({ data: created, error: insertError } = await adminClient
      .from("orders")
      .insert(retryPayload)
      .select("id")
      .single());
  }

  // Base sem a migração 20261111000004: mantém o pedido e registra a bandeira
  // nas observações (o entregador continua sabendo qual maquininha levar).
  if (
    insertError &&
    /meal_voucher/i.test(insertError.message ?? "") &&
    /does not exist|could not find|schema cache/i.test(insertError.message ?? "")
  ) {
    const retryPayload = { ...orderPayload };
    delete retryPayload.meal_voucher;
    if (mealVoucherNote) {
      retryPayload.notes = [notesValue, mealVoucherNote]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
    }
    ({ data: created, error: insertError } = await adminClient
      .from("orders")
      .insert(retryPayload)
      .select("id")
      .single());
  }

  // Base sem a migração 20261116000001: mantém o pedido e registra tipo/bandeira
  // do cartão nas observações (o entregador continua sabendo qual cartão
  // conferir antes de passar na maquininha).
  if (
    insertError &&
    /card_brand|card_type/i.test(insertError.message ?? "") &&
    /does not exist|could not find|schema cache/i.test(insertError.message ?? "")
  ) {
    const retryPayload: Record<string, unknown> = { ...orderPayload };
    delete retryPayload.card_brand;
    delete retryPayload.card_type;
    if (cardPaymentNote) {
      retryPayload.notes = [notesValue, cardPaymentNote]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
    }
    ({ data: created, error: insertError } = await adminClient
      .from("orders")
      .insert(retryPayload)
      .select("id")
      .single());

    // Base legada que também não tem `orders.meal_voucher`: solta a coluna e
    // garante as duas bandeiras nas observações (nada de informação perdida).
    if (
      insertError &&
      /meal_voucher/i.test(insertError.message ?? "") &&
      (mealVoucherNote || cardPaymentNote)
    ) {
      const fallbackPayload = { ...retryPayload };
      delete fallbackPayload.meal_voucher;
      fallbackPayload.notes = [notesValue, mealVoucherNote, cardPaymentNote]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      ({ data: created, error: insertError } = await adminClient
        .from("orders")
        .insert(fallbackPayload)
        .select("id")
        .single());
    }
  }

  if (insertError || !created) {
    const detail =
      insertError && typeof insertError === "object"
        ? ((insertError as { message?: unknown }).message ??
          (insertError as { details?: unknown }).details ??
          (insertError as { hint?: unknown }).hint ??
          (insertError as { code?: unknown }).code)
        : null;
    // Erro detalhado: inclui a mensagem do Supabase/PostgREST para revelar
    // exatamente qual campo ou restrição falhou (coluna ausente, NOT NULL,
    // FK, check...). Coluna inexistente → 400 com dica; demais → 500.
    const detailText =
      typeof detail === "string" && detail.trim()
        ? detail.trim()
        : "Não foi possível registrar o pedido. Tente novamente.";
    const missingColumn = /column .* does not exist|schema cache|Could not find/i.test(
      detailText
    );
    return NextResponse.json(
      {
        error: missingColumn
          ? `Falha ao gravar o pedido: ${detailText} — verifique se as colunas da tabela orders estão criadas no Supabase.`
          : detailText,
      },
      { status: missingColumn ? 400 : 500 }
    );
  }

  // Resgate de fidelidade: os pontos só são debitados com o pedido já gravado
  // (a função SQL é idempotente por pedido). Se o saldo mudou entre a validação
  // acima e este ponto (corrida), o pedido é removido e o cliente recebe um
  // erro claro — nunca entregamos desconto sem debitar os pontos.
  if (loyaltyPointsToRedeem > 0) {
    const loyaltyOrderCode = `#${created.id
      .replace(/-/g, "")
      .slice(0, 6)
      .toUpperCase()}`;
    const newBalance = await redeemLoyaltyPoints(adminClient, {
      establishmentId,
      phone: loyaltyPhone,
      points: loyaltyPointsToRedeem,
      orderId: created.id,
      description: `Resgate do pedido ${loyaltyOrderCode}`,
    });

    if (newBalance === null) {
      const { error: cleanupError } = await adminClient
        .from("orders")
        .delete()
        .eq("id", created.id);
      if (cleanupError) {
        console.error(
          `[orders] Falha ao remover o pedido ${created.id} após falha no resgate de pontos:`,
          cleanupError.message
        );
      }
      return NextResponse.json(
        {
          error:
            "Não foi possível resgatar os pontos de fidelidade. Confira seu saldo e finalize o pedido novamente.",
        },
        { status: 400 }
      );
    }
  }

  // Resgate no modo por pedidos: o prêmio só é debitado com o pedido já gravado
  // (a função SQL é idempotente por pedido e grava os produtos entregues em
  // `orders.loyalty_reward_product_ids`). Se o cliente não tiver mais o prêmio
  // (corrida com outro pedido), o pedido é removido — nunca entregamos os
  // produtos grátis sem debitar o prêmio.
  if (loyaltyFreeProducts.length > 0) {
    const progress = await redeemLoyaltyFreeReward(adminClient, {
      establishmentId,
      phone: loyaltyPhone,
      orderId: created.id,
      productIds: loyaltyRewardProductIds,
      productNames: loyaltyFreeProducts.map((product) => product.name),
      quantity: loyaltyRewardQuantity,
      ordersPerReward: loyaltyOrdersPerReward,
    });

    if (!progress) {
      const { error: cleanupError } = await adminClient
        .from("orders")
        .delete()
        .eq("id", created.id);
      if (cleanupError) {
        console.error(
          `[orders] Falha ao remover o pedido ${created.id} após falha no resgate do prêmio de fidelidade:`,
          cleanupError.message
        );
      }
      return NextResponse.json(
        {
          error:
            "Não foi possível usar o prêmio de fidelidade. Confira seus prêmios e finalize o pedido novamente.",
        },
        { status: 400 }
      );
    }
  }

  // Consome uma unidade do limite do cupom. Feito APÓS o insert para não
  // consumir uso quando o pedido falha. A função SQL é atômica (evita que
  // pedidos concorrentes ultrapassem `max_uses`) e respeita a validade; se a
  // base ainda não tem a função, cai no incremento simples via update.
  if (coupon) {
    const { data: consumed, error: consumeError } = await adminClient.rpc(
      "consume_coupon_usage",
      { p_coupon_id: coupon.id }
    );

    if (consumeError) {
      const { error: updateError } = await adminClient
        .from("coupons")
        .update({ used_count: toCouponNumber(coupon.used_count) + 1 })
        .eq("id", coupon.id);
      if (updateError) {
        console.error(
          "[orders] Falha ao incrementar used_count do cupom:",
          updateError.message
        );
      }
    } else if (consumed === false) {
      console.error(
        "[orders] Cupom atingiu o limite de usos durante a criação do pedido:",
        coupon.id
      );
    }
  }

  // Notificação automática de NOVO PEDIDO para a loja (Evolution API).
  //
  // Roda depois de o pedido estar gravado — o banco é a fonte da verdade e um
  // WhatsApp fora do ar nunca desfaz o pedido. O `await` é intencional: em
  // ambientes serverless a função pode ser congelada logo após a resposta, então
  // disparar em background arriscaria perder a mensagem. O timeout curto de
  // `ORDER_NOTIFICATION_TIMEOUT_MS` limita a espera.
  try {
    const notification = await notifyStoreNewOrder({
      store: establishment,
      order: {
        id: created.id,
        status: "pendente",
        items: orderItems,
        customer_name: customerName,
        customer_phone: customerPhoneDigits,
        customer_address: addressData,
        subtotal,
        delivery_fee: deliveryFee,
        total,
        payment_method: paymentMethod,
        meal_voucher: mealVoucherValue,
        /** Tipo/bandeira do cartão na entrega (null nas demais formas). */
        card_type: cardTypeValue,
        card_brand: cardBrandValue,
        change_for: changeForValue,
        notes: notesValue,
        // Modalidade explícita: pedidos de retirada não têm endereço e a
        // mensagem da loja destaca "Retirada no balcão".
        delivery_type: orderType,
        estimated_delivery_time: estimatedDeliveryTime,
      },
    });

    // O formato do retorno já vira log no módulo de notificações; aqui fica o
    // vínculo com o pedido, que é o identificador usado no painel/suporte.
    if (!notification.ok) {
      console.warn(
        `[orders] Notificação da loja sobre o pedido ${created.id} não enviada: ${
          notification.error ?? "motivo desconhecido"
        }`
      );
    }
  } catch (notificationError) {
    console.error(
      "[orders] Falha inesperada ao notificar a loja sobre o novo pedido:",
      notificationError
    );
  }

  // Resumo do pedido no WhatsApp da loja.
  //
  // Regras (ver `lib/whatsappOrder.ts`):
  // - O pedido já foi gravado acima e aparece normalmente no painel.
  // - A loja precisa ter o recurso ativo (`whatsapp_checkout_enabled !== false`)
  //   e um WhatsApp/telefone válido. Caso contrário `whatsapp_url` volta `null`
  //   e o checkout apenas segue o fluxo normal, sem quebrar a experiência.
  const whatsappUrl = buildStoreOrderWhatsAppUrl(
    establishment as {
      whatsapp?: string | null;
      phone?: string | null;
      whatsapp_checkout_enabled?: boolean | null;
    },
    {
      orderId: created.id,
      establishmentName: establishment.name,
      customerName,
      customerPhone: customerPhoneDigits,
      items: orderItems,
      address: addressData,
      subtotal,
      deliveryFee,
      couponDiscount,
      couponCode: coupon?.code ?? null,
      total,
      paymentMethod,
      mealVoucher: mealVoucherValue,
      cardType: cardTypeValue,
      cardBrand: cardBrandValue,
      changeFor: changeForValue,
      notes: notesValue,
      // Modalidade explícita (sobrepõe a inferência por endereço).
      deliveryType: orderType,
      estimatedDeliveryTime,
    }
  );

  return NextResponse.json(
    {
      order: {
        id: created.id,
        total,
        subtotal,
        delivery_fee: deliveryFee,
        coupon_code: coupon?.code ?? null,
        coupon_discount: couponDiscount,
        discount_amount: couponDiscount,
        estimated_delivery_time: estimatedDeliveryTime,
        estimated_delivery_at: estimatedDeliveryAt,
        status: "pendente",
        /** `entrega` ou `retirada` (modalidade escolhida no checkout). */
        delivery_type: orderType,
        /** Forma escolhida (inclui `pix_online` no Split de Pagamentos). */
        payment_method: paymentMethod,
        /** Bandeira do vale na entrega (null nas demais formas). */
        meal_voucher: mealVoucherValue,
        /** Tipo/bandeira do cartão na entrega (null nas demais formas). */
        card_type: cardTypeValue,
        card_brand: cardBrandValue,
        /** `pendente` no PIX Online até o webhook confirmar o pagamento. */
        payment_status:
          paymentMethod === "pix_online" ? "pendente" : undefined,
        /** Distância da rota usada no cálculo (km) e tempo estimado. */
        delivery_distance_km: deliveryDistanceKm,
        delivery_duration_minutes: deliveryDurationMinutes,
        /** Link `wa.me` com o resumo do pedido (null quando indisponível). */
        whatsapp_url: whatsappUrl,
      },
      establishment: { id: establishment.id, name: establishment.name },
    },
    { status: 201 }
  );
}

/**
 * PUT /api/orders
 *
 * Atualiza o status de um pedido.
 *
 * O painel pode avançar, voltar ou pular etapas: nenhuma transição é bloqueada,
 * apenas o valor do status é validado. Isso permite ao operador corrigir um
 * status enviado por engano (inclusive reativar um pedido cancelado).
 *
 * Segurança: só quem gerencia o estabelecimento dono do pedido pode alterá-lo.
 *
 * Body: { id, status, action?, cancellation_reason?, estimated_delivery_time_min?,
 *         estimated_delivery_time_max? }
 *  - action = "accept" (botão **Aceitar pedido**): equivale a status =
 *    "preparando", só é aceito para pedidos `pendente` e é o momento em que o
 *    cliente recebe a mensagem de confirmação no WhatsApp.
 *  - status = "cancelado" exige `cancellation_reason` (mínimo 3 caracteres).
 *  - ao sair de "cancelado", o motivo é limpo automaticamente.
 *  - a previsão (min/max) é opcional; quando enviada, também regrava o texto e
 *    o instante previsto (`estimated_delivery_at`) a partir de agora.
 */
export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: {
    id?: string;
    status?: string;
    /**
     * Ação explícita do painel. `"accept"` é o botão **Aceitar pedido**:
     * atalho para `preparando` e ÚNICO momento em que o cliente recebe a
     * mensagem de pedido confirmado (o `POST /api/orders` notifica só a loja).
     */
    action?: string;
    cancellation_reason?: string;
    estimated_delivery_time_min?: number;
    estimated_delivery_time_max?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const id = body.id?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "Informe o id do pedido." },
      { status: 400 }
    );
  }
  const action =
    typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  const isAcceptAction = action === "accept" || action === "aceitar";
  // O aceite é um atalho semântico para "pedido confirmado / em preparo".
  const nextStatus = isAcceptAction
    ? ("preparando" as const)
    : normalizeOrderStatusValue(body.status);
  if (!nextStatus) {
    return NextResponse.json(
      { error: `Status inválido. Use: ${ORDER_STATUSES.join(", ")}.` },
      { status: 400 }
    );
  }

  // Cancelamento exige justificativa do atendente (salva em cancellation_reason).
  const cancellationReason =
    typeof body.cancellation_reason === "string"
      ? body.cancellation_reason.trim()
      : "";
  if (nextStatus === "cancelado" && cancellationReason.length < 3) {
    return NextResponse.json(
      { error: "Informe o motivo do cancelamento (mínimo 3 caracteres)." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  const { data: existing, error: findError } = await adminClient
    .from("orders")
    .select("establishment_id, status")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      { error: findError.message ?? "Falha ao localizar o pedido." },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Pedido não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode alterar pedidos deste estabelecimento." },
      { status: 403 }
    );
  }

  // Nenhuma transição é bloqueada: o operador pode corrigir o status livremente.
  const currentStatus = normalizeOrderStatusValue(existing.status);
  // Aceite só vale para pedido PENDENTE: evita "aceitar" duas vezes (o que
  // reenviaria a mensagem de confirmação ao cliente) ou aceitar um cancelado.
  if (isAcceptAction && currentStatus !== "pendente") {
    return NextResponse.json(
      {
        error:
          "Este pedido não está pendente — ele já foi aceito ou cancelado.",
      },
      { status: 409 }
    );
  }
  const updates: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === "cancelado") {
    updates.cancellation_reason = cancellationReason;
  } else if (currentStatus === "cancelado") {
    // Reativação: limpa o motivo antigo para não exibir justificativa obsoleta.
    updates.cancellation_reason = null;
  }

  // Previsão opcional enviada pelo painel (opções rápidas ao mudar o status).
  const estimateMinProvided = body.estimated_delivery_time_min !== undefined;
  const estimateMaxProvided = body.estimated_delivery_time_max !== undefined;
  if (estimateMinProvided !== estimateMaxProvided) {
    return NextResponse.json(
      {
        error:
          "Informe o tempo mínimo e o tempo máximo da previsão de entrega juntos.",
      },
      { status: 400 }
    );
  }
  if (estimateMinProvided && estimateMaxProvided) {
    const window: EstimatedDeliveryWindow = {
      min: Number(body.estimated_delivery_time_min),
      max: Number(body.estimated_delivery_time_max),
    };
    if (!isValidEstimatedDeliveryWindow(window)) {
      return NextResponse.json(
        {
          error:
            "A previsão de entrega deve usar minutos inteiros válidos, com o máximo maior ou igual ao mínimo.",
        },
        { status: 400 }
      );
    }
    updates.estimated_delivery_time = formatEstimatedDeliveryWindow(window);
    updates.estimated_delivery_at = estimatedDeliveryAtFromNow(window);
  }

  let { data: updated, error: updateError } = await adminClient
    .from("orders")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  const missingCancellationColumn = (message: string): boolean =>
    /cancellation_reason/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message));

  const missingEstimatedColumn = (message: string): boolean =>
    /estimated_delivery_time|estimated_delivery_at/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message));

  // Bases antigas podem não ter a coluna: reativa sem tentar limpar o motivo.
  if (
    updateError &&
    nextStatus !== "cancelado" &&
    currentStatus === "cancelado" &&
    missingCancellationColumn(updateError.message)
  ) {
    ({ data: updated, error: updateError } = await adminClient
      .from("orders")
      .update({ status: nextStatus })
      .eq("id", id)
      .select()
      .single());
  }

  // Base sem a migração 20261110000015: atualiza o status sem a previsão.
  if (
    updateError &&
    ("estimated_delivery_time" in updates ||
      "estimated_delivery_at" in updates) &&
    missingEstimatedColumn(updateError.message)
  ) {
    delete updates.estimated_delivery_time;
    delete updates.estimated_delivery_at;
    ({ data: updated, error: updateError } = await adminClient
      .from("orders")
      .update(updates)
      .eq("id", id)
      .select()
      .single());
  }

  if (updateError || !updated) {
    const message = updateError?.message ?? "Falha ao atualizar o pedido.";
    return NextResponse.json(
      {
        error: missingCancellationColumn(message)
          ? 'A coluna "cancellation_reason" ainda não existe. Execute a migração 20261110000010_add_cancellation_reason_to_orders.sql no SQL Editor do Supabase.'
          : message,
      },
      { status: 400 }
    );
  }

  // Fidelidade (migração 20261118000001): credita os pontos quando o pedido é
  // finalizado e devolve o que foi movimentado quando ele é cancelado. As duas
  // operações são idempotentes por pedido, então reabrir/repetir o status não
  // duplica pontos. Falhas nunca derrubam a mudança de status (o painel precisa
  // continuar operando); ficam registradas no log do módulo.
  let loyaltySummary: OrderNotificationLoyaltySummary | null = null;
  if (currentStatus !== nextStatus) {
    const movement =
      nextStatus === "finalizado"
        ? await creditLoyaltyForCompletedOrder(adminClient, updated)
        : nextStatus === "cancelado"
          ? await reverseLoyaltyForCanceledOrder(adminClient, updated)
          : null;

    if (movement) {
      const loyaltyProgram = await fetchLoyaltyProgram(
        adminClient,
        existing.establishment_id
      );

      if (movement.orders) {
        // Modo por pedidos: a mensagem mostra o ciclo atual e o prêmio liberado
        // (ou devolvido, no cancelamento). Não existe saldo de pontos.
        loyaltySummary = {
          rewardMode: "orders",
          pointsEarned: 0,
          balance: movement.balance,
          nextRewardRemaining: 0,
          rewardLabel: loyaltyRewardLabel(loyaltyProgram),
          ordersCount: movement.orders.orders_count,
          ordersPerReward: movement.orders.orders_per_reward,
          ordersRemaining: movement.orders.orders_remaining,
          freeRewardsAvailable: movement.orders.free_rewards_available,
          rewardUnlocked: movement.orders.reward_unlocked,
          rewardReturned: movement.orders.reward_returned,
          rewardQuantity: loyaltyProgram.reward_product_quantity,
        };
      } else {
        if (nextStatus === "finalizado") {
          updated.loyalty_points_earned = movement.points;
        }
        loyaltySummary = {
          pointsEarned: nextStatus === "finalizado" ? movement.points : 0,
          balance: movement.balance,
          nextRewardRemaining: loyaltyNextRewardRemaining(
            loyaltyProgram,
            movement.balance
          ),
          rewardLabel: loyaltyRewardLabel(loyaltyProgram),
        };
      }
    }
  }

  // Notificação automática de mudança de etapa para o CLIENTE (Evolution API).
  //
  // Em `pendente → preparando` este é o momento do botão "Aceitar pedido": o
  // cliente recebe a confirmação ("pedido confirmado e já começou a ser
  // preparado"). Na criação do pedido (`POST /api/orders`) só a LOJA é avisada.
  //
  // Só dispara quando o status realmente muda: regravar o mesmo status (ex.:
  // apenas atualizar a previsão de entrega) não pode duplicar a mensagem. O
  // envio usa a instância da loja e nunca altera a resposta — falhas ficam
  // registradas no log do servidor.
  if (currentStatus !== nextStatus) {
    try {
      const store = await fetchOrderNotificationStore(
        adminClient,
        existing.establishment_id
      );
      const notification = await notifyOrderStatusChange({
        store,
        order: updated,
        previousStatus: currentStatus,
        loyalty: loyaltySummary,
      });

      // Omitir (pedido sem telefone, loja sem instância, status sem mensagem)
      // já sai no log do módulo como `[whatsapp:pedido] ... ignorado`. Aqui só
      // as FALHAS reais ganham o vínculo com o pedido e a transição de status.
      if (!notification.ok && !notification.skipped) {
        console.warn(
          `[orders] Notificação de status (${currentStatus} → ${nextStatus}) do pedido ${id} falhou: ${
            notification.error ?? "motivo desconhecido"
          }`
        );
      }
    } catch (notificationError) {
      console.error(
        "[orders] Falha inesperada ao notificar o cliente sobre o status:",
        notificationError
      );
    }
  }

  return NextResponse.json({ order: updated }, { status: 200 });
}
