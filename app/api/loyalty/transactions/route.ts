import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import { LOYALTY_PHONE_MIN_DIGITS, normalizeLoyaltyPhone } from "@/lib/loyalty";
import {
  fetchLoyaltyAccount,
  listLoyaltyTransactions,
} from "@/lib/loyalty-server";

/**
 * GET /api/loyalty/transactions — extrato de pontos de um cliente.
 *
 * Query: ?establishment_id? (super_admin), ?phone, ?limit
 *
 * Usado pelo painel de fidelidade ao selecionar um participante.
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
      { error: "Você não tem acesso ao extrato desta loja." },
      { status: 403 }
    );
  }

  const phone = normalizeLoyaltyPhone(url.searchParams.get("phone"));
  if (phone.length < LOYALTY_PHONE_MIN_DIGITS) {
    return NextResponse.json(
      { error: "Informe o telefone do cliente com DDD." },
      { status: 400 }
    );
  }

  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;

  const adminClient = createAdminClient();
  const account = await fetchLoyaltyAccount(adminClient, establishmentId, phone);
  const { transactions, error } = await listLoyaltyTransactions(
    adminClient,
    establishmentId,
    phone,
    limit
  );

  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  return NextResponse.json(
    { account, transactions, phone },
    { status: 200 }
  );
}
