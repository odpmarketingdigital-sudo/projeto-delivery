import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  getOwnedEstablishmentId,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  isValidCouponCode,
  normalizeCouponCode,
  roundCurrency,
  toCouponNumber,
  type CouponDiscountType,
} from "@/lib/coupons";

/** Campos editáveis de um cupom enviados pelo painel. */
type CouponPayload = {
  establishment_id?: unknown;
  code?: unknown;
  discount_type?: unknown;
  discount_value?: unknown;
  min_order_value?: unknown;
  usage_limit?: unknown;
  active?: unknown;
};

type ValidatedFields = {
  code?: string;
  discount_type?: CouponDiscountType;
  discount_value?: number;
  min_order_value?: number | null;
  usage_limit?: number | null;
  active?: boolean;
};

/**
 * Valida e normaliza os campos de cupom.
 *
 * `requireAll` = true (POST): exige código, tipo, valor e define defaults de
 * pedido mínimo/limite/ativo. `requireAll` = false (PUT): valida apenas os
 * campos presentes (atualização parcial).
 */
function validateCouponFields(
  body: CouponPayload,
  requireAll: boolean
): { fields: ValidatedFields; error: string | null } {
  const fields: ValidatedFields = {};

  if (body.code !== undefined || requireAll) {
    const code = normalizeCouponCode(
      typeof body.code === "string" ? body.code : ""
    );
    if (!code) return { fields, error: "Informe o código do cupom." };
    if (!isValidCouponCode(code)) {
      return {
        fields,
        error:
          "Código inválido. Use de 3 a 40 caracteres (letras, números, hífen ou sublinhado).",
      };
    }
    fields.code = code;
  }

  if (body.discount_type !== undefined || requireAll) {
    const raw =
      typeof body.discount_type === "string" ? body.discount_type.trim() : "";
    if (raw !== "percentage" && raw !== "fixed") {
      return {
        fields,
        error: "Tipo de desconto inválido. Use percentage ou fixed.",
      };
    }
    fields.discount_type = raw;
  }

  if (body.discount_value !== undefined || requireAll) {
    const value = Number(body.discount_value);
    if (!Number.isFinite(value) || value <= 0) {
      return { fields, error: "Informe um valor de desconto maior que zero." };
    }
    fields.discount_value = roundCurrency(value);
  }

  if (body.min_order_value !== undefined) {
    if (body.min_order_value === null || body.min_order_value === "") {
      fields.min_order_value = null;
    } else {
      const value = Number(body.min_order_value);
      if (!Number.isFinite(value) || value < 0) {
        return {
          fields,
          error: "O pedido mínimo deve ser um valor válido (zero ou mais).",
        };
      }
      fields.min_order_value = roundCurrency(value);
    }
  } else if (requireAll) {
    fields.min_order_value = null;
  }

  if (body.usage_limit !== undefined) {
    if (body.usage_limit === null || body.usage_limit === "") {
      fields.usage_limit = null;
    } else {
      const value = Number(body.usage_limit);
      if (!Number.isInteger(value) || value < 1) {
        return {
          fields,
          error: "O limite de usos deve ser um número inteiro maior que zero.",
        };
      }
      fields.usage_limit = value;
    }
  } else if (requireAll) {
    fields.usage_limit = null;
  }

  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      return { fields, error: "O campo ativo deve ser booleano." };
    }
    fields.active = body.active;
  } else if (requireAll) {
    fields.active = true;
  }

  if (
    fields.discount_type === "percentage" &&
    fields.discount_value !== undefined &&
    fields.discount_value > 100
  ) {
    return {
      fields,
      error: "O desconto percentual não pode ultrapassar 100%.",
    };
  }

  return { fields, error: null };
}

/** Mensagem amigável para erros de schema (migração ainda não aplicada). */
function schemaErrorHint(message: string): string {
  if (/does not exist|schema cache|could not find/i.test(message)) {
    return 'A tabela de cupons ainda não existe. Execute a migração 20261110000011_create_coupons.sql no SQL Editor do Supabase.';
  }
  if (/duplicate key|unique constraint/i.test(message)) {
    return "Já existe um cupom com esse código nesta loja.";
  }
  return message;
}

/**
 * GET /api/coupons?establishment_id=xxx
 *
 * Lista os cupons do estabelecimento (mais recentes primeiro).
 * Segurança: sessão obrigatória; admin vê a própria loja, super admin qualquer
 * uma (mesmo padrão de /api/products).
 */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const requestedId = new URL(request.url).searchParams.get(
    "establishment_id"
  );

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    requestedId
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
      { error: "Você não tem acesso aos cupons deste estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("coupons")
    .select("*")
    .eq("establishment_id", establishmentId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: schemaErrorHint(error.message ?? "Falha ao carregar os cupons.") },
      { status: 400 }
    );
  }

  return NextResponse.json({ coupons: data ?? [] }, { status: 200 });
}

/**
 * POST /api/coupons — cria um cupom.
 *
 * Body: { establishment_id? (super_admin), code, discount_type,
 *         discount_value, min_order_value?, usage_limit?, active? }
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: CouponPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  let establishmentId: string | null;
  if (guard.isSuperAdmin) {
    establishmentId =
      typeof body.establishment_id === "string"
        ? body.establishment_id.trim()
        : null;
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Informe o establishment_id do cupom." },
        { status: 400 }
      );
    }
  } else {
    establishmentId = await getOwnedEstablishmentId(guard.user.id);
    if (!establishmentId) {
      return NextResponse.json(
        { error: "Sua conta não possui um estabelecimento associado." },
        { status: 403 }
      );
    }
  }

  const { fields, error: validationError } = validateCouponFields(body, true);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const adminClient = createAdminClient();
  const { data: created, error } = await adminClient
    .from("coupons")
    .insert({ establishment_id: establishmentId, ...fields })
    .select()
    .single();

  if (error || !created) {
    const message = error?.message ?? "Falha ao criar o cupom.";
    return NextResponse.json(
      { error: schemaErrorHint(message) },
      { status: /duplicate key|unique constraint/i.test(message) ? 409 : 400 }
    );
  }

  return NextResponse.json({ coupon: created }, { status: 201 });
}

/**
 * PUT /api/coupons — atualiza um cupom (parcial ou completo).
 *
 * Body: { id, code?, discount_type?, discount_value?, min_order_value?,
 *         usage_limit?, active? }
 */
export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: CouponPayload & { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json(
      { error: "Informe o id do cupom." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();
  const { data: existing, error: findError } = await adminClient
    .from("coupons")
    .select("establishment_id, discount_type, discount_value")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      {
        error: schemaErrorHint(
          findError.message ?? "Falha ao localizar o cupom."
        ),
      },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Cupom não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode editar cupons deste estabelecimento." },
      { status: 403 }
    );
  }

  const { fields, error: validationError } = validateCouponFields(body, false);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }
  if (Object.keys(fields).length === 0) {
    return NextResponse.json(
      { error: "Nenhum campo para atualizar." },
      { status: 400 }
    );
  }

  // Valida o percentual considerando os valores já gravados (update parcial).
  const effectiveType = fields.discount_type ?? existing.discount_type;
  const effectiveValue =
    fields.discount_value ?? toCouponNumber(existing.discount_value);
  if (effectiveType === "percentage" && effectiveValue > 100) {
    return NextResponse.json(
      { error: "O desconto percentual não pode ultrapassar 100%." },
      { status: 400 }
    );
  }

  const { data: updated, error } = await adminClient
    .from("coupons")
    .update(fields)
    .eq("id", id)
    .select()
    .single();

  if (error || !updated) {
    const message = error?.message ?? "Falha ao atualizar o cupom.";
    return NextResponse.json(
      { error: schemaErrorHint(message) },
      { status: /duplicate key|unique constraint/i.test(message) ? 409 : 400 }
    );
  }

  return NextResponse.json({ coupon: updated }, { status: 200 });
}

/**
 * DELETE /api/coupons — exclui um cupom.
 *
 * Body: { id }
 */
export async function DELETE(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json(
      { error: "Informe o id do cupom." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();
  const { data: existing, error: findError } = await adminClient
    .from("coupons")
    .select("establishment_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) {
    return NextResponse.json(
      {
        error: schemaErrorHint(
          findError.message ?? "Falha ao localizar o cupom."
        ),
      },
      { status: 400 }
    );
  }
  if (!existing) {
    return NextResponse.json({ error: "Cupom não encontrado." }, { status: 404 });
  }

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    existing.establishment_id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não pode excluir cupons deste estabelecimento." },
      { status: 403 }
    );
  }

  const { error: deleteError } = await adminClient
    .from("coupons")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json(
      {
        error: schemaErrorHint(
          deleteError.message ?? "Falha ao excluir o cupom."
        ),
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, id }, { status: 200 });
}



