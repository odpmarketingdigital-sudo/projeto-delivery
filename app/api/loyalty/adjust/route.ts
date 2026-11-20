import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  LOYALTY_MAX_POINTS_PER_REWARD,
  LOYALTY_PHONE_MIN_DIGITS,
  normalizeLoyaltyPhone,
} from "@/lib/loyalty";
import {
  adjustLoyaltyPoints,
  fetchLoyaltyAccount,
} from "@/lib/loyalty-server";

type AdjustBody = {
  establishment_id?: unknown;
  phone?: unknown;
  customer_name?: unknown;
  /** Delta em pontos: positivo credita, negativo debita. */
  delta?: unknown;
  points?: unknown;
  description?: unknown;
};

/** Limite de segurança para um ajuste manual (evita erros de digitação). */
const MAX_ADJUST_DELTA = LOYALTY_MAX_POINTS_PER_REWARD;

/**
 * POST /api/loyalty/adjust — ajuste manual de pontos pelo painel.
 *
 * Body: { establishment_id? (super_admin), phone, delta | points,
 *         customer_name?, description? }
 *
 * `delta` positivo credita e negativo debita; o saldo nunca fica abaixo de
 * zero (regra da função SQL `loyalty_adjust_points`, fonte da verdade).
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: AdjustBody;
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
      { error: "Você não pode ajustar pontos desta loja." },
      { status: 403 }
    );
  }

  const phone = normalizeLoyaltyPhone(body.phone);
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS) {
    return NextResponse.json(
      { error: "Informe o telefone do cliente com DDD." },
      { status: 400 }
    );
  }

  const rawDelta = body.delta !== undefined ? body.delta : body.points;
  const delta = Math.trunc(Number(rawDelta));
  if (!Number.isFinite(delta) || delta === 0) {
    return NextResponse.json(
      { error: "Informe quantos pontos adicionar ou remover (diferente de 0)." },
      { status: 400 }
    );
  }
  if (Math.abs(delta) > MAX_ADJUST_DELTA) {
    return NextResponse.json(
      { error: `O ajuste máximo por operação é de ${MAX_ADJUST_DELTA} pontos.` },
      { status: 400 }
    );
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const customerName =
    typeof body.customer_name === "string" ? body.customer_name.trim() : "";

  const adminClient = createAdminClient();
  const balance = await adjustLoyaltyPoints(adminClient, {
    establishmentId,
    phone,
    customerName: customerName || null,
    delta,
    description:
      description ||
      (delta > 0 ? "Crédito manual do painel" : "Débito manual do painel"),
  });

  if (balance === null) {
    return NextResponse.json(
      {
        error:
          "Não foi possível ajustar os pontos. Verifique se a migração de fidelidade foi executada e se o cliente possui saldo suficiente.",
      },
      { status: 400 }
    );
  }

  const account = await fetchLoyaltyAccount(adminClient, establishmentId, phone);

  return NextResponse.json(
    {
      account,
      balance,
    },
    { status: 200 }
  );
}
