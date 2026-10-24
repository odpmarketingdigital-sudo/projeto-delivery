import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * Autorização para a gestão do cardápio (/api/products e /api/categories).
 *
 * Regras:
 *  - É preciso estar autenticado (sessão válida via cookies).
 *  - `super_admin` pode gerir o cardápio de QUALQUER estabelecimento.
 *  - `admin` só pode gerir o cardápio do PRÓPRIO estabelecimento (a linha em
 *    `establishments` cujo `user_id` é o do usuário logado).
 *
 * O papel é confirmado por duas fontes (basta uma), espelhando adminGuard:
 *  `user_metadata.role` (JWT) e a tabela `profiles` (service role, bypass RLS).
 */
export type MenuGuard =
  | { ok: true; user: User; isSuperAdmin: boolean }
  | { ok: false; response: NextResponse };

export async function requireMenuAccess(): Promise<MenuGuard> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Não autenticado. Faça login para continuar." },
        { status: 401 }
      ),
    };
  }

  // Fonte 1 (rápida): papel declarado nos metadados do JWT.
  if (user.user_metadata?.role === "super_admin") {
    return { ok: true, user, isSuperAdmin: true };
  }

  // Fonte 2 (authority): tabela `profiles` via service role (bypass de RLS).
  const adminClient = createAdminClient();
  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  return { ok: true, user, isSuperAdmin: profile?.role === "super_admin" };
}

/**
 * Retorna o `establishment_id` (uuid) do estabelecimento pertencente ao
 * usuário informado, ou `null` se ele não tiver um estabelecimento.
 *
 * Usado para que um `admin` nunca precise (nem consiga) inventar um
 * `establishment_id` — o servidor resolve o correto a partir da sessão.
 */
export async function getOwnedEstablishmentId(
  userId: string
): Promise<string | null> {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from("establishments")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  return data?.id ?? null;
}

/**
 * Resolve o `establishment_id` alvo de uma leitura do cardápio.
 *
 * - `super_admin`: exige `establishment_id` explícito na querystring (pode gerir
 *   qualquer loja, então o alvo precisa ser informado).
 * - `admin`: usa o `establishment_id` informado quando presente (validado depois
 *   via `canManageEstablishment`), ou resolve automaticamente o próprio
 *   estabelecimento a partir da sessão (tabela `establishments` + papel em
 *   `profiles`, ver `requireMenuAccess`).
 *
 * Retorna `{ id }` em caso de sucesso ou `{ response }` com o erro HTTP.
 */
export async function resolveMenuEstablishment(
  userId: string,
  isSuperAdmin: boolean,
  requestedId: string | null | undefined
): Promise<{ id: string } | { response: NextResponse }> {
  const requested = requestedId?.trim() || null;
  if (requested) return { id: requested };

  if (isSuperAdmin) {
    return {
      response: NextResponse.json(
        { error: "Parâmetro establishment_id é obrigatório." },
        { status: 400 }
      ),
    };
  }

  const ownedId = await getOwnedEstablishmentId(userId);
  if (!ownedId) {
    return {
      response: NextResponse.json(
        { error: "Sua conta não possui um estabelecimento associado." },
        { status: 403 }
      ),
    };
  }
  return { id: ownedId };
}

/**
 * Verifica se o usuário pode gerir o estabelecimento informado.
 * - `super_admin`: sempre true.
 * - `admin`: true apenas se o estabelecimento for dele (user_id === userId).
 */
export async function canManageEstablishment(
  userId: string,
  isSuperAdmin: boolean,
  establishmentId: string
): Promise<boolean> {
  if (isSuperAdmin) return true;

  const ownedId = await getOwnedEstablishmentId(userId);
  return ownedId !== null && ownedId === establishmentId;
}
