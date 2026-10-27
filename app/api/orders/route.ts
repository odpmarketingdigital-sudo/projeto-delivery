import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  requireMenuAccess,
  canManageEstablishment,
} from "@/lib/supabase/menuGuard";
import { isStoreOpen } from "@/lib/openingHours";
import { quoteDelivery } from "@/lib/deliveryQuote";
import { normalizeDeliverySettings } from "@/lib/delivery";
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
  roundCurrency,
  toCouponNumber,
  type CouponRecord,
} from "@/lib/coupons";
import { buildStoreOrderWhatsAppUrl } from "@/lib/whatsappOrder";

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
 * Aliases aceitos na borda (query/body): `em_preparo` → `preparando`,
 * `saiu_para_entrega` → `entrega`, `concluido` → `finalizado`.
 */
const STATUS_ALIASES: Record<string, OrderStatusValue> = {
  em_preparo: "preparando",
  saiu_para_entrega: "entrega",
  concluido: "finalizado",
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
 *   customer: { name, phone, street, number, neighborhood, complement?, reference? },
 *   payment_method: "pix" | "cartao" | "dinheiro",
 *   change_for?: number | null,
 *   notes?: string,
 *   coupon_code?: string,
 *   items: [{ productId, quantity, addonIds: string[], notes? }]
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
      complement?: string;
      reference?: string;
      /** CEP do endereço (obrigatório no modelo por distância/raio). */
      cep?: string;
    };
    payment_method?: string;
    change_for?: number | null;
    notes?: string;
    /** Código do cupom aplicado no checkout (opcional). */
    coupon_code?: string;
    items?: Array<{
      productId?: string;
      quantity?: number;
      addonIds?: string[];
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

  if (customerName.length < 3) {
    return NextResponse.json(
      { error: "Informe seu nome completo." },
      { status: 400 }
    );
  }
  if (!street || !number || !neighborhood) {
    return NextResponse.json(
      { error: "Informe o endereço de entrega (rua, número e bairro)." },
      { status: 400 }
    );
  }

  const paymentMethod = body.payment_method?.trim() ?? "";
  if (!["pix", "cartao", "dinheiro"].includes(paymentMethod)) {
    return NextResponse.json(
      { error: "Selecione a forma de pagamento." },
      { status: 400 }
    );
  }


  // A loja precisa existir e estar ativa (mesma regra da vitrine).
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
  if (!establishment || establishment.status !== "ativo") {
    return NextResponse.json(
      { error: "Estabelecimento indisponível no momento." },
      { status: 404 }
    );
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
  // `quoteDelivery` valida o CEP, geocodifica, calcula a distância (Haversine)
  // e aplica o modelo configurado pela loja (fixo ou por km).
  const deliveryResult = await quoteDelivery(
    establishment,
    typeof customer.cep === "string" ? customer.cep : null
  );
  if (!deliveryResult.ok) {
    return NextResponse.json(
      { error: deliveryResult.error },
      { status: deliveryResult.status }
    );
  }
  const deliveryQuote = deliveryResult.quote;

  if (!deliveryQuote.within_radius) {
    return NextResponse.json(
      {
        error:
          `Endereço fora do raio de entrega da loja` +
          (deliveryQuote.distance_km != null
            ? ` (${deliveryQuote.distance_km} km de distância, limite de ${deliveryQuote.max_delivery_radius_km} km).`
            : "."),
      },
      { status: 400 }
    );
  }

  const productIds = [
    ...new Set(
      rawItems
        .map((item) => item.productId?.trim())
        .filter((id): id is string => Boolean(id))
    ),
  ];

  // Constrói a consulta de produtos. Aplica `.in("id", ...)` apenas quando há
  // IDs válidos para filtrar — evita passar `"__none__"` (string inválida para
  // coluna uuid) e quebrar a consulta.
  const { data: productRows, error: productsError } =
    productIds.length > 0
      ? await adminClient
          .from("products")
          .select("id, name, price, is_active")
          .eq("establishment_id", establishmentId)
          .in("id", productIds)
      : await adminClient
          .from("products")
          .select("id, name, price, is_active")
          .eq("establishment_id", establishmentId);

  if (productsError) {
    return NextResponse.json(
      { error: productsError.message ?? "Falha ao carregar os produtos." },
      { status: 400 }
    );
  }

  const productById = new Map(
    ((productRows ?? []) as Array<{
      id: string;
      name: string;
      price: number | string;
      is_active: boolean;
    }>).map((row) => [row.id, row])
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

    const basePrice = Number(product.price) || 0;
    const unitPrice = basePrice + addonsPrice;
    const lineTotal = unitPrice * quantity;
    subtotal += lineTotal;

    orderItems.push({
      product_id: product.id,
      name: product.name,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      addons: selectedAddons,
      ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
    });
  }

  // Taxa de entrega já validada/recalculada acima por `quoteDelivery`.
  const deliveryFee = deliveryQuote.fee;

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
            ? "Cupons indisponíveis no momento. Execute a migração 20261110000011_create_coupons.sql no Supabase."
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

    couponDiscount = computeCouponDiscount(
      {
        discount_type: coupon.discount_type,
        discount_value: toCouponNumber(coupon.discount_value),
        min_order_value:
          coupon.min_order_value == null
            ? null
            : toCouponNumber(coupon.min_order_value),
      },
      subtotal
    );
  }

  const total = Math.max(
    0,
    roundCurrency(subtotal + deliveryFee - couponDiscount)
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
  const addressData = {
    street,
    number,
    neighborhood,
    complement: customer.complement?.trim() ?? "",
    reference: customer.reference?.trim() ?? "",
    cep: deliveryQuote.cep,
  };
  const itemsData = orderItems ?? [];
  const notesValue = body.notes?.trim() || null;

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
    change_for: changeForValue ?? null,
    notes: notesValue ?? null,
    estimated_delivery_time: estimatedDeliveryTime,
    estimated_delivery_at: estimatedDeliveryAt,
    // Colunas de cupom só são enviadas quando um cupom foi aplicado: assim
    // pedidos sem cupom continuam funcionando mesmo em bases que ainda não
    // executaram a migração 20261110000011.
    ...(coupon
      ? {
          coupon_id: coupon.id,
          coupon_code: coupon.code,
          coupon_discount: couponDiscount,
        }
      : {}),
    status: "pendente",
  };

  let { data: created, error: insertError } = await adminClient
    .from("orders")
    .insert(orderPayload)
    .select("id")
    .single();

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

  // Consome uma unidade do limite do cupom. Feito APÓS o insert para não
  // consumir uso quando o pedido falha. A função SQL é atômica (evita que
  // pedidos concorrentes ultrapassem `usage_limit`); se a base ainda não tem a
  // função, cai no incremento simples via update.
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
      changeFor: changeForValue,
      notes: notesValue,
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
        estimated_delivery_time: estimatedDeliveryTime,
        estimated_delivery_at: estimatedDeliveryAt,
        status: "pendente",
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
 * Body: { id, status, cancellation_reason?, estimated_delivery_time_min?,
 *         estimated_delivery_time_max? }
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
  const nextStatus = normalizeOrderStatusValue(body.status);
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

  return NextResponse.json({ order: updated }, { status: 200 });
}
