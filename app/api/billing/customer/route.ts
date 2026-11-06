import { NextResponse } from "next/server";
import {
  isValidCpfCnpj,
  type BillingCustomerPrefill,
  type BillingCustomerPrefillResponse,
} from "@/lib/billing";
import { resolveOwnerName } from "@/lib/registration";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import { normalizeWhatsAppNumber } from "@/lib/whatsappOrder";

/** Colunas do pré-preenchimento (migrações 1 = phone, 6 = whatsapp, 20 = documento). */
const CUSTOMER_COLUMNS =
  "id, user_id, name, owner_name, email, phone, whatsapp, document_number";

/** Colunas mínimas em bases sem as migrações de WhatsApp/documento. */
const LEGACY_COLUMNS = "id, user_id, name, owner_name, email, phone";

/** Ordem de recuo quando uma migração ainda não rodou. */
const COLUMN_SETS = [CUSTOMER_COLUMNS, LEGACY_COLUMNS] as const;

/** Erro do PostgREST indicando coluna ausente (migração pendente). */
const MISSING_COLUMN_PATTERN = /owner_name|whatsapp|document_number/i;

/** Linha lida de `establishments` (só o que o checkout usa). */
interface CustomerEstablishmentRow {
  id: string;
  user_id: string | null;
  name: string | null;
  owner_name: string | null;
  email: string | null;
  phone?: string | null;
  /** Coluna da migração 20261110000006. */
  whatsapp?: string | null;
  /** Coluna da migração 20261110000020 (só dígitos). */
  document_number?: string | null;
}

/** Linha lida de `profiles` (fallback para lojas legadas). */
interface CustomerProfileRow {
  name: string | null;
  email: string | null;
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Primeiro texto não vazio da lista (com `trim`). */
function firstFilled(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = (value ?? "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * Documento somente com dígitos — apenas quando é um CPF (11) ou CNPJ (14)
 * válido. Valores incompletos/inválidos são tratados como ausentes para não
 * pré-preencher um campo que a validação do checkout rejeitaria.
 */
function documentDigits(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return isValidCpfCnpj(digits) ? digits : "";
}

/**
 * Telefone no formato local (DDD + número, sem o DDI 55), que é o esperado pelo
 * campo com máscara `(00) 00000-0000`. O `whatsapp` da loja costuma estar
 * salvo como `5511999999999`; números inválidos devolvem "".
 */
function localPhoneDigits(raw: string | null | undefined): string {
  const normalized = normalizeWhatsAppNumber(raw);
  return normalized ? normalized.slice(2) : "";
}

/**
 * GET /api/billing/customer?establishment_id=... — dados para pré-preencher o
 * passo 1 ("Seus dados") do modal de assinatura em `/painel/assinatura`.
 *
 * O checkout não deve começar em branco: o lojista já informou nome, e-mail,
 * CPF/CNPJ e WhatsApp no onboarding. Esta rota devolve exatamente esses dados
 * (somente leitura) para o modal usá-los como estado inicial — os campos
 * continuam editáveis, pois a nota fiscal pode ser emitida para outro
 * e-mail/documento.
 *
 * Fontes, nesta ordem:
 *  1. `establishments` — `document_number` (CPF/CNPJ do onboarding),
 *     `whatsapp`/`phone` (telefone da loja), `owner_name` e `email`;
 *  2. `profiles` do dono da loja — `name`/`email` (lojas legadas);
 *  3. sessão logada — e-mail da conta e nome dos metadados (`resolveOwnerName`).
 *
 * Mesma autorização de `/api/establishment`: `admin` só lê a própria loja;
 * `super_admin` informa o `establishment_id` da loja que está operando.
 *
 * Respostas:
 *  - 200 com `BillingCustomerPrefillResponse` (campos podem vir vazios);
 *  - 400/401/403/404/500 com `{ error }`.
 */
export async function GET(request: Request) {
  // 1) Sessão + papel (admin da loja ou super_admin operando uma loja).
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  // 2) Loja alvo: a própria do usuário ou a informada pelo super_admin.
  const requestedId = new URL(request.url).searchParams.get("establishment_id");
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
    return fail("Você não tem acesso a este estabelecimento.", 403);
  }

  const adminClient = createAdminClient();

  // 3) Dados da loja — com recuo pelas migrações pendentes.
  let row: CustomerEstablishmentRow | null = null;
  let missingColumns = false;

  for (const columns of COLUMN_SETS) {
    const { data, error } = await adminClient
      .from("establishments")
      .select(columns)
      .eq("id", resolved.id)
      .maybeSingle();

    if (!error) {
      row = (data as unknown as CustomerEstablishmentRow | null) ?? null;
      missingColumns = false;
      break;
    }

    if (!MISSING_COLUMN_PATTERN.test(error.message ?? "")) {
      console.error(
        "[billing/customer] falha ao ler o estabelecimento",
        error.message
      );
      return fail("Não foi possível carregar seus dados cadastrados.", 500);
    }

    missingColumns = true;
  }

  // Loja inexistente (id válido, mas sem linha) → 404. Base legada sem as
  // colunas esperadas segue adiante com os dados do perfil/sessão.
  if (!row && !missingColumns) {
    return fail("Estabelecimento não encontrado.", 404);
  }

  // 4) Perfil do dono da loja (nome/e-mail de exibição, quando existir).
  let profile: CustomerProfileRow | null = null;
  if (row?.user_id) {
    const { data } = await adminClient
      .from("profiles")
      .select("name, email")
      .eq("id", row.user_id)
      .maybeSingle();

    profile = (data as unknown as CustomerProfileRow | null) ?? null;
  }

  // 5) Monta o pré-preenchimento (nome/e-mail caem para a sessão logada).
  const customer: BillingCustomerPrefill = {
    name: firstFilled(
      row?.owner_name,
      profile?.name,
      resolveOwnerName(guard.user.user_metadata, guard.user.email)
    ),
    email: firstFilled(row?.email, profile?.email, guard.user.email),
    cpfCnpj: documentDigits(row?.document_number),
    phone: localPhoneDigits(row?.whatsapp) || localPhoneDigits(row?.phone),
  };

  const response: BillingCustomerPrefillResponse = { customer };
  return NextResponse.json(response);
}

