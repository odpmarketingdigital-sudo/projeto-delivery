import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";
import {
  validateSubscriptionCouponFields,
  type SubscriptionCouponRecord,
} from "@/lib/subscription-coupons";
import {
  SubscriptionCouponsSchemaError,
  createSubscriptionCoupon,
  deleteSubscriptionCoupon,
  findSubscriptionCouponById,
  listSubscriptionCoupons,
  subscriptionCouponsSchemaHint,
  updateSubscriptionCoupon,
} from "@/lib/subscription-coupons-server";

/**
 * CRUD dos cupons de ASSINATURA (exclusivo do Super Admin).
 *
 * Camada de gerenciamento usada por `/painel/admin/cupons`. Diferente de
 * `/api/coupons` (cupons do cardápio, por estabelecimento), estes cupons são
 * globais e incidem sobre o total do período no checkout do plano.
 *
 *  GET    → `{ coupons: SubscriptionCouponRecord[], schemaPending }`
 *  POST   → cria (body: code, discount_type, discount_value, usage_limit?, active?)
 *  PATCH  → atualiza (body: id + campos a alterar)
 *  DELETE → remove (`?id=` ou body `{ id }`)
 *
 * A tabela vive na migração `20261110000018_create_subscription_coupons.sql`;
 * quando ela não existe, o GET responde `schemaPending: true` e as escritas
 * devolvem a instrução da migração.
 */

const DENIED = "Apenas o Super Admin pode gerenciar os cupons de assinatura.";

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Objeto JSON (ou `null` quando o valor não é um objeto simples). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Body JSON da requisição (`null` quando inválido). */
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await request.json());
  } catch {
    return null;
  }
}

/** `id` informado no body ou na query string. */
function readCouponId(
  body: Record<string, unknown> | null,
  request: Request
): string {
  const fromBody = body && typeof body.id === "string" ? body.id.trim() : "";
  if (fromBody) return fromBody;

  const fromQuery = new URL(request.url).searchParams.get("id") ?? "";
  return fromQuery.trim();
}

/** Traduz o erro do banco na resposta HTTP da rota. */
function errorResponse(error: Error): NextResponse {
  console.error("[admin/subscription-coupons]", error.message);

  if (error instanceof SubscriptionCouponsSchemaError) {
    return fail(error.message, 500);
  }

  if (/duplicate key|unique constraint/i.test(error.message)) {
    return fail("Já existe um cupom com este código.", 409);
  }

  return fail(subscriptionCouponsSchemaHint(error.message));
}

export async function GET() {
  const guard = await requireSuperAdmin(DENIED);
  if (!guard.ok) return guard.response;

  try {
    const { coupons, schemaPending } = await listSubscriptionCoupons();
    return NextResponse.json(
      { coupons, schemaPending },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[admin/subscription-coupons] GET", error);
    return fail("Não foi possível carregar os cupons de assinatura.", 500);
  }
}

export async function POST(request: Request) {
  const guard = await requireSuperAdmin(DENIED);
  if (!guard.ok) return guard.response;

  const body = await readBody(request);
  if (!body) return fail("Corpo da requisição inválido.");

  const { fields, error } = validateSubscriptionCouponFields(body);
  if (!fields) return fail(error ?? "Dados do cupom inválidos.");

  const result = await createSubscriptionCoupon(fields, guard.user.id);
  if (!result.coupon) return errorResponse(result.error);

  return NextResponse.json(
    { coupon: result.coupon as SubscriptionCouponRecord },
    { status: 201 }
  );
}

export async function PATCH(request: Request) {
  const guard = await requireSuperAdmin(DENIED);
  if (!guard.ok) return guard.response;

  const body = await readBody(request);
  if (!body) return fail("Corpo da requisição inválido.");

  const id = readCouponId(body, request);
  if (!id) return fail("Informe o cupom que será atualizado.");

  let existing: SubscriptionCouponRecord | null;
  try {
    existing = await findSubscriptionCouponById(id);
  } catch (error) {
    console.error("[admin/subscription-coupons] PATCH", error);
    return fail("Não foi possível carregar o cupom.", 500);
  }

  if (!existing) return fail("Cupom não encontrado.", 404);

  // Mescla a linha atual com o body: o PATCH aceita alterações parciais
  // (ex.: só `{ id, active: false }`), mas valida o registro completo.
  const { fields, error } = validateSubscriptionCouponFields({
    code: body.code ?? existing.code,
    discount_type: body.discount_type ?? existing.discount_type,
    discount_value: body.discount_value ?? existing.discount_value,
    usage_limit:
      body.usage_limit !== undefined ? body.usage_limit : existing.usage_limit,
    active: body.active !== undefined ? body.active : existing.active,
  });
  if (!fields) return fail(error ?? "Dados do cupom inválidos.");

  const result = await updateSubscriptionCoupon(id, fields);
  if (!result.coupon) return errorResponse(result.error);

  return NextResponse.json(
    { coupon: result.coupon },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function DELETE(request: Request) {
  const guard = await requireSuperAdmin(DENIED);
  if (!guard.ok) return guard.response;

  const body = await readBody(request);
  const id = readCouponId(body, request);
  if (!id) return fail("Informe o cupom que será removido.");

  const { error } = await deleteSubscriptionCoupon(id);
  if (error) return errorResponse(error);

  return NextResponse.json({ success: true, id });
}
