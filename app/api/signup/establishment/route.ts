/**
 * POST /api/signup/establishment
 *
 * Completa o cadastro de um usuário **já autenticado** — caso típico do login
 * com Google: o OAuth cria o usuário, mas não conhece nome da loja, CPF/CNPJ,
 * WhatsApp nem o link do cardápio. A tela `/completar-cadastro` envia esses
 * dados para cá.
 *
 * Regras:
 *  - exige sessão válida (401 sem usuário);
 *  - revalida o payload com `lib/registration.ts` (mesmas regras do `/cadastro`);
 *  - cria a loja na primeira vez e ATUALIZA nas seguintes (idempotente);
 *  - promove o perfil a `admin` e marca `onboarding_complete` (necessário para
 *    o painel, já que o trigger de `profiles` cria o papel `cliente`);
 *  - dispara o e-mail de boas-vindas apenas na criação (best effort).
 */

import { NextResponse } from "next/server";
import { sendWelcomeEmailSafely } from "@/lib/email/welcome";
import {
  normalizeEstablishmentDraft,
  ownerNameError,
  resolveOwnerName,
  validateEstablishmentDraft,
  type DocumentType,
  type EstablishmentDraft,
  type EstablishmentErrors,
} from "@/lib/registration";
import {
  saveEstablishmentForUser,
  type SaveEstablishmentResult,
} from "@/lib/supabase/establishments";
import { createAdminClient, createClient } from "@/lib/supabase/server";

/** Campos aceitos (os mesmos nomes usados pelo formulário). */
interface SignupEstablishmentBody {
  owner_name?: unknown;
  name?: unknown;
  establishment_name?: unknown;
  document_type?: unknown;
  document_number?: unknown;
  whatsapp?: unknown;
  phone?: unknown;
  slug?: unknown;
}

/** Ordem de exibição dos erros (o primeiro vira a mensagem principal). */
const FIELD_ORDER = [
  "name",
  "document_type",
  "document_number",
  "whatsapp",
  "slug",
] as const;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Devolve o primeiro erro na ordem visual do formulário. */
function firstError(
  errors: EstablishmentErrors
): { field: (typeof FIELD_ORDER)[number]; message: string } | null {
  for (const field of FIELD_ORDER) {
    const message = errors[field];
    if (message) return { field, message };
  }
  return null;
}

function fail(error: string, status: number, field?: string) {
  return NextResponse.json(field ? { error, field } : { error }, { status });
}

/** Resposta padronizada de sucesso (201 na criação, 200 na atualização). */
function saved(result: Extract<SaveEstablishmentResult, { ok: true }>) {
  return NextResponse.json(
    {
      establishment: result.establishment,
      created: result.created,
      ...(result.warning ? { warning: result.warning } : {}),
    },
    { status: result.created ? 201 : 200 }
  );
}

export async function POST(request: Request) {
  // 1) Sessão — o usuário vem do OAuth (Google) ou de um cadastro já existente.
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return fail("Sua sessão expirou. Entre novamente para concluir o cadastro.", 401);
  }

  // 2) Corpo da requisição.
  let body: SignupEstablishmentBody;

  try {
    body = (await request.json()) as SignupEstablishmentBody;
  } catch {
    return fail("Corpo da requisição inválido.", 400);
  }

  // 3) Responsável: o formulário pode ajustar o nome sugerido pelo Google.
  const ownerName =
    readString(body.owner_name) ||
    resolveOwnerName(user.user_metadata, user.email);
  const ownerMessage = ownerNameError(ownerName);

  if (ownerMessage) return fail(ownerMessage, 400, "owner_name");

  // 4) Tipo de documento (CPF padrão; valor desconhecido é rejeitado).
  const rawType = readString(body.document_type).toLowerCase();
  if (rawType && rawType !== "cpf" && rawType !== "cnpj") {
    return fail("Escolha CPF ou CNPJ.", 400, "document_type");
  }
  const documentType: DocumentType = rawType === "cnpj" ? "cnpj" : "cpf";

  const draft: EstablishmentDraft = {
    name: readString(body.name) || readString(body.establishment_name),
    document_type: documentType,
    document_number: readString(body.document_number),
    whatsapp: readString(body.whatsapp) || readString(body.phone),
    slug: readString(body.slug),
  };

  const errors = validateEstablishmentDraft(draft);
  const invalid = firstError(errors);
  if (invalid) return fail(invalid.message, 400, invalid.field);

  // 5) Persistência (service role: ignora RLS e resolve o dono pela sessão).
  const normalized = normalizeEstablishmentDraft(draft);
  const adminClient = createAdminClient();
  const result = await saveEstablishmentForUser(adminClient, user.id, {
    name: normalized.name,
    ownerName,
    email: user.email ?? "",
    whatsapp: normalized.whatsapp,
    documentType: normalized.documentType,
    documentNumber: normalized.documentNumber,
    slug: normalized.slug,
  });

  if (!result.ok) return fail(result.error, result.status, result.field);

  // 6) E-mail de boas-vindas — apenas na criação e sem bloquear a resposta.
  if (result.created && user.email) {
    await sendWelcomeEmailSafely({
      to: user.email,
      ownerName,
      establishmentName: result.establishment.name,
      slug: result.establishment.slug,
      trialEndsAt: result.establishment.trial_ends_at,
    });
  }

  return saved(result);
}
