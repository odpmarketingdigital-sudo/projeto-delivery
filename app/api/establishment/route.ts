import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import {
  requireMenuAccess,
  canManageEstablishment,
  getOwnedEstablishmentId,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import { deleteProductImageFromStorage } from "@/lib/supabase/storage";
import { normalizeOpeningHours, parseOpeningHours } from "@/lib/openingHours";
import { parseCep, toFiniteNumber } from "@/lib/delivery";
import {
  MAX_ESTIMATED_DELIVERY_MINUTES,
  MIN_ESTIMATED_DELIVERY_MINUTES,
} from "@/lib/deliveryEstimate";

/** Campos aceitos no body do PUT /api/establishment. */
export interface IdentityUpdate {
  establishment_id?: string;
  logo_url?: string;
  banner_url?: string;
  /** Nome público do estabelecimento (não altera o slug da URL). */
  name?: string;
  /** Texto abaixo do nome no cardápio público (string vazia limpa o campo). */
  description?: string;
  /** Horários de funcionamento por dia da semana (jsonb). */
  opening_hours?: unknown;
  /** Modelo de frete: taxa fixa ou cálculo por distância (km). */
  delivery_type?: "fixed" | "distance";
  /** Taxa fixa (e fallback do modelo por distância). */
  delivery_fee?: number;
  /** Distância inclusa na taxa base (km). */
  distance_base_km?: number;
  /** Valor cobrado até `distance_base_km`. */
  distance_base_fee?: number;
  /** Valor por km excedente. */
  distance_extra_km_fee?: number;
  /** Raio máximo de entrega (km). `null` remove o limite. */
  max_delivery_radius_km?: number | null;
  /** CEP da loja (origem do cálculo). `null`/vazio limpa. */
  store_cep?: string | null;
  store_latitude?: number | null;
  store_longitude?: number | null;
  /** Tempo mínimo estimado de entrega (minutos) — migração 20261110000015. */
  estimated_delivery_time_min?: number;
  /** Tempo máximo estimado de entrega (minutos) — migração 20261110000015. */
  estimated_delivery_time_max?: number;
}

/** Limite de caracteres espelhado no formulário do painel. */
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;

/** Colunas da migração 20261110000014 (entrega por distância). */
const DELIVERY_FIELDS = [
  "delivery_type",
  "delivery_fee",
  "distance_base_km",
  "distance_base_fee",
  "distance_extra_km_fee",
  "max_delivery_radius_km",
  "store_cep",
  "store_latitude",
  "store_longitude",
] as const;

const DELIVERY_SQL =
  "alter table public.establishments add column if not exists delivery_type text not null default 'fixed', add column if not exists distance_base_km numeric(6,2) not null default 3, add column if not exists distance_base_fee numeric(10,2) not null default 0, add column if not exists distance_extra_km_fee numeric(10,2) not null default 0, add column if not exists max_delivery_radius_km numeric(6,2), add column if not exists store_cep text, add column if not exists store_latitude double precision, add column if not exists store_longitude double precision;";

/** Colunas da migração 20261110000015 (previsão de entrega). */
const ESTIMATE_FIELDS = [
  "estimated_delivery_time_min",
  "estimated_delivery_time_max",
] as const;

const ESTIMATE_SQL =
  "alter table public.establishments add column if not exists estimated_delivery_time_min integer not null default 30, add column if not exists estimated_delivery_time_max integer not null default 50;";

function isMissingEstimateColumn(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  const mentionsColumn = ESTIMATE_FIELDS.some((field) =>
    new RegExp(field, "i").test(message)
  );
  return (
    mentionsColumn &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

function isMissingDeliveryColumn(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  const mentionsColumn = DELIVERY_FIELDS.some((field) =>
    new RegExp(field, "i").test(message)
  );
  return (
    mentionsColumn &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

/** Número finito >= 0 (aceita string numérica vinda de formulários). */
function nonNegativeNumber(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function isMissingDescriptionColumn(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  return (
    /description/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

function isMissingOpeningHoursColumn(
  error: { code?: string | null; message?: string | null } | null
): boolean {
  const message = error?.message ?? "";
  return (
    /opening_hours/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

/**
 * GET /api/establishment?establishment_id=xxx
 *
 * Lê as configurações da loja (incluindo `opening_hours`). Para `admin`, o
 * estabelecimento é resolvido pela sessão; `super_admin` informa o id.
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

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso a este estabelecimento." },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("establishments")
    .select("*")
    .eq("id", resolved.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message ?? "Falha ao carregar as configurações da loja." },
      { status: 400 }
    );
  }
  if (!data) {
    return NextResponse.json(
      { error: "Estabelecimento não encontrado." },
      { status: 404 }
    );
  }

  const row = data as unknown as { opening_hours?: unknown };
  return NextResponse.json(
    {
      establishment: {
        ...data,
        opening_hours: normalizeOpeningHours(row.opening_hours),
      },
    },
    { status: 200 }
  );
}

export async function PUT(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  // 1) Lê o corpo da requisição uma única vez.
  let body: IdentityUpdate;
  try {
    body = (await request.json()) as IdentityUpdate;
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  // 1) Resolve o estabelecimento alvo.
  let establishmentId: string;
  if (guard.isSuperAdmin) {
    const bodyId = body?.establishment_id?.trim() || "";
    const queryId = new URL(request.url).searchParams.get("establishment_id")?.trim() || "";

    if (!bodyId && !queryId) {
      return NextResponse.json(
        { error: "establishment_id é obrigatório para super admin." },
        { status: 400 }
      );
    }
    establishmentId = bodyId || queryId;
    if (!(await canManageEstablishment(guard.user.id, true, establishmentId))) {
      return NextResponse.json(
        { error: "Você não tem acesso a este estabelecimento." },
        { status: 403 }
      );
    }
  } else {
    const ownedId = await getOwnedEstablishmentId(guard.user.id);
    if (!ownedId) {
      return NextResponse.json(
        { error: "Sua conta não possui um estabelecimento associado." },
        { status: 403 }
      );
    }
    establishmentId = ownedId;
  }

  // 2) Valida os campos no corpo já lido.
  const updateFields: Record<string, unknown> = {};
  if (body.logo_url !== undefined) {
    const url = body.logo_url.trim();
    if (url === "") {
      return NextResponse.json(
        { error: "logo_url não pode ser vazio." },
        { status: 400 }
      );
    }
    updateFields.logo_url = url;
  }
  if (body.banner_url !== undefined) {
    const url = body.banner_url.trim();
    if (url === "") {
      return NextResponse.json(
        { error: "banner_url não pode ser vazio." },
        { status: 400 }
      );
    }
    updateFields.banner_url = url;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return NextResponse.json(
        { error: "name deve ser uma string." },
        { status: 400 }
      );
    }
    const name = body.name.trim();
    if (name === "") {
      return NextResponse.json(
        { error: "O nome do estabelecimento não pode ser vazio." },
        { status: 400 }
      );
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.` },
        { status: 400 }
      );
    }
    updateFields.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return NextResponse.json(
        { error: "description deve ser uma string." },
        { status: 400 }
      );
    }
    const description = body.description.trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        {
          error: `A descrição deve ter no máximo ${MAX_DESCRIPTION_LENGTH} caracteres.`,
        },
        { status: 400 }
      );
    }
    updateFields.description = description === "" ? null : description;
  }
  if (body.opening_hours !== undefined) {
    const parsed = parseOpeningHours(body.opening_hours);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    updateFields.opening_hours = parsed.value;
  }

  // ---- Entrega e frete (migração 20261110000014) --------------------------
  if (body.delivery_type !== undefined) {
    if (body.delivery_type !== "fixed" && body.delivery_type !== "distance") {
      return NextResponse.json(
        { error: 'delivery_type deve ser "fixed" ou "distance".' },
        { status: 400 }
      );
    }
    updateFields.delivery_type = body.delivery_type;
  }

  const moneyFields: Array<[keyof IdentityUpdate, string]> = [
    ["delivery_fee", "taxa fixa de entrega"],
    ["distance_base_km", "distância base (km)"],
    ["distance_base_fee", "taxa base por distância"],
    ["distance_extra_km_fee", "taxa por km excedente"],
  ];
  for (const [field, label] of moneyFields) {
    if (body[field] === undefined) continue;
    const parsed = nonNegativeNumber(body[field]);
    if (parsed == null) {
      return NextResponse.json(
        { error: `A ${label} deve ser um número maior ou igual a zero.` },
        { status: 400 }
      );
    }
    updateFields[field] = parsed;
  }

  if (body.max_delivery_radius_km !== undefined) {
    if (body.max_delivery_radius_km === null) {
      updateFields.max_delivery_radius_km = null;
    } else {
      const radius = toFiniteNumber(body.max_delivery_radius_km);
      if (radius == null || radius <= 0) {
        return NextResponse.json(
          {
            error:
              "O raio máximo de entrega deve ser maior que zero ou vazio (sem limite).",
          },
          { status: 400 }
        );
      }
      updateFields.max_delivery_radius_km = radius;
    }
  }

  if (body.store_cep !== undefined) {
    if (body.store_cep === null || body.store_cep === "") {
      updateFields.store_cep = null;
    } else {
      const cep = parseCep(body.store_cep);
      if (!cep) {
        return NextResponse.json(
          { error: "O CEP da loja deve ter 8 dígitos." },
          { status: 400 }
        );
      }
      updateFields.store_cep = cep;
    }
  }

  const latitudeProvided = body.store_latitude !== undefined;
  const longitudeProvided = body.store_longitude !== undefined;
  if (latitudeProvided !== longitudeProvided) {
    return NextResponse.json(
      { error: "Informe latitude e longitude da loja juntas." },
      { status: 400 }
    );
  }
  if (latitudeProvided && longitudeProvided) {
    if (body.store_latitude === null || body.store_longitude === null) {
      updateFields.store_latitude = null;
      updateFields.store_longitude = null;
    } else {
      const latitude = toFiniteNumber(body.store_latitude);
      const longitude = toFiniteNumber(body.store_longitude);
      if (
        latitude == null ||
        longitude == null ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return NextResponse.json(
          { error: "Coordenadas da loja inválidas." },
          { status: 400 }
        );
      }
      updateFields.store_latitude = latitude;
      updateFields.store_longitude = longitude;
    }
  }

  // ---- Previsão de entrega (migração 20261110000015) ----------------------
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
    const min = toFiniteNumber(body.estimated_delivery_time_min);
    const max = toFiniteNumber(body.estimated_delivery_time_max);
    if (
      min == null ||
      max == null ||
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < MIN_ESTIMATED_DELIVERY_MINUTES ||
      max > MAX_ESTIMATED_DELIVERY_MINUTES ||
      max < min
    ) {
      return NextResponse.json(
        {
          error:
            `A previsão de entrega deve usar minutos inteiros entre ${MIN_ESTIMATED_DELIVERY_MINUTES} e ${MAX_ESTIMATED_DELIVERY_MINUTES}, ` +
            "com o máximo maior ou igual ao mínimo.",
        },
        { status: 400 }
      );
    }
    updateFields.estimated_delivery_time_min = min;
    updateFields.estimated_delivery_time_max = max;
  }

  if (Object.keys(updateFields).length === 0) {
    return NextResponse.json(
      {
        error:
          "Informe ao menos um campo: `name`, `description`, `opening_hours`, `logo_url`, `banner_url` ou configurações de entrega.",
      },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();

  // 2.1) Busca os dados atuais do estabelecimento antes da atualização
  // para podermos identificar e remover a logo ou banner antigos do Storage.
  const { data: existingEstablishment } = await adminClient
    .from("establishments")
    .select("logo_url, banner_url")
    .eq("id", establishmentId)
    .single();

  const BASE_SELECT =
    "id, user_id, name, owner_name, email, phone, status, slug, logo_url, banner_url, updated_at";
  const DESCRIPTION_SQL =
    "alter table public.establishments add column if not exists description text;";
  const OPENING_HOURS_SQL =
    "alter table public.establishments add column if not exists opening_hours jsonb not null default '{}'::jsonb;";

  const buildSelect = (
    withDescription: boolean,
    withOpeningHours: boolean
  ) =>
    [
      BASE_SELECT,
      withDescription ? "description" : null,
      withOpeningHours ? "opening_hours" : null,
    ]
      .filter(Boolean)
      .join(", ");

  const runUpdate = (
    fields: Record<string, unknown>,
    withDescription: boolean,
    withOpeningHours: boolean
  ) =>
    adminClient
      .from("establishments")
      .update(fields)
      .eq("id", establishmentId)
      .select(buildSelect(withDescription, withOpeningHours))
      .single();

  const hasDescription = "description" in updateFields;
  const hasOpeningHours = "opening_hours" in updateFields;
  const hasDelivery = DELIVERY_FIELDS.some((field) => field in updateFields);
  const hasEstimate = ESTIMATE_FIELDS.some((field) => field in updateFields);

  // Campos efetivamente enviados no UPDATE. Bases legadas podem não ter a
  // coluna `description`; nesse caso seguimos com o restante dos campos e os
  // fallbacks abaixo precisam partir desse subconjunto (e não do body original).
  let currentFields: Record<string, unknown> = updateFields;

  let { data: updated, error: updateError } = await runUpdate(
    currentFields,
    hasDescription,
    hasOpeningHours
  );

  let warning: string | null = null;
  if (
    updateError &&
    hasDescription &&
    isMissingDescriptionColumn(updateError)
  ) {
    const rest: Record<string, unknown> = { ...currentFields };
    delete rest.description;
    if (Object.keys(rest).length > 0) {
      currentFields = rest;
      ({ data: updated, error: updateError } = await runUpdate(
        rest,
        false,
        hasOpeningHours
      ));
      warning =
        'A coluna "description" ainda não existe na tabela establishments. ' +
        `Execute no SQL Editor do Supabase: ${DESCRIPTION_SQL}`;
    } else {
      return NextResponse.json(
        {
          error:
            'A coluna "description" ainda não existe no banco. ' +
            `Execute no SQL Editor do Supabase: ${DESCRIPTION_SQL}`,
        },
        { status: 400 }
      );
    }
  }

  if (
    updateError &&
    hasOpeningHours &&
    isMissingOpeningHoursColumn(updateError)
  ) {
    return NextResponse.json(
      {
        error:
          'A coluna "opening_hours" ainda não existe no banco. ' +
          `Execute no SQL Editor do Supabase: ${OPENING_HOURS_SQL}`,
      },
      { status: 400 }
    );
  }

  if (
    updateError &&
    hasDelivery &&
    isMissingDeliveryColumn(updateError)
  ) {
    const rest: Record<string, unknown> = { ...currentFields };
    for (const field of DELIVERY_FIELDS) delete rest[field];

    if (Object.keys(rest).length > 0) {
      currentFields = rest;
      ({ data: updated, error: updateError } = await runUpdate(
        rest,
        "description" in rest,
        "opening_hours" in rest
      ));
      const deliveryWarning =
        "As configurações de entrega ainda não foram gravadas: as colunas da " +
        "migração 20261110000014_add_delivery_distance_settings.sql não existem. " +
        `Execute no SQL Editor do Supabase: ${DELIVERY_SQL}`;
      warning = warning ? `${warning} ${deliveryWarning}` : deliveryWarning;
    } else {
      return NextResponse.json(
        {
          error:
            "As colunas de entrega ainda não existem no banco. Execute a " +
            "migração 20261110000014_add_delivery_distance_settings.sql no SQL Editor do Supabase. " +
            `SQL: ${DELIVERY_SQL}`,
        },
        { status: 400 }
      );
    }
  }
  if (
    updateError &&
    hasEstimate &&
    isMissingEstimateColumn(updateError)
  ) {
    const rest: Record<string, unknown> = { ...currentFields };
    for (const field of ESTIMATE_FIELDS) delete rest[field];

    if (Object.keys(rest).length > 0) {
      currentFields = rest;
      ({ data: updated, error: updateError } = await runUpdate(
        rest,
        "description" in rest,
        "opening_hours" in rest
      ));
      const estimateWarning =
        "A previsão de entrega ainda não foi gravada: as colunas da " +
        "migração 20261110000015_add_estimated_delivery_time.sql não existem. " +
        `Execute no SQL Editor do Supabase: ${ESTIMATE_SQL}`;
      warning = warning ? `${warning} ${estimateWarning}` : estimateWarning;
    } else {
      return NextResponse.json(
        {
          error:
            "As colunas de previsão de entrega ainda não existem no banco. " +
            "Execute a migração 20261110000015_add_estimated_delivery_time.sql no SQL Editor do Supabase. " +
            `SQL: ${ESTIMATE_SQL}`,
        },
        { status: 400 }
      );
    }
  }



  if (updateError || !updated) {
    const notFound = updateError?.code === "PGRST116";
    return NextResponse.json(
      {
        error: notFound
          ? "Estabelecimento não encontrado."
          : updateError?.message ?? "Falha ao atualizar as configurações visuais.",
      },
      { status: notFound ? 404 : 400 }
    );
  }

  // 3) Se o UPDATE deu certo, remove as imagens antigas do Storage (se tiverem mudado)
  if (existingEstablishment) {
    const oldLogo = existingEstablishment.logo_url;
    const newLogo = updateFields.logo_url;
    if (newLogo && oldLogo && oldLogo !== newLogo) {
      await deleteProductImageFromStorage(oldLogo);
    }

    const oldBanner = existingEstablishment.banner_url;
    const newBanner = updateFields.banner_url;
    if (newBanner && oldBanner && oldBanner !== newBanner) {
      await deleteProductImageFromStorage(oldBanner);
    }
  }

  // As colunas de entrega não entram no `.select()` para não quebrar bases
  // legadas; devolvemos os valores recém-validados junto do registro.
  const deliveryUpdates: Record<string, unknown> = {};
  for (const field of [...DELIVERY_FIELDS, ...ESTIMATE_FIELDS]) {
    if (field in currentFields) {
      deliveryUpdates[field] = currentFields[field];
    }
  }
  // O select é montado dinamicamente (string), então o Supabase não infere o
  // formato da linha; tratamos como objeto genérico para mesclar a entrega.
  const updatedRecord = (updated ?? {}) as unknown as Record<string, unknown>;

  return NextResponse.json(
    {
      establishment: { ...updatedRecord, ...deliveryUpdates },
      ...(warning ? { warning } : {}),
    },
    { status: 200 }
  );
}