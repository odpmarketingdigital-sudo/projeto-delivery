import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * Resultado da verificação de Super Admin.
 * - `ok: true`  → chamador autorizado; `user` é o usuário autenticado.
 * - `ok: false` → `response` é um NextResponse de erro (401/403) pronto para
 *   ser retornado pela rota.
 */
export type SuperAdminGuard =
  | { ok: true; user: User }
  | { ok: false; response: NextResponse };

/**
 * Verifica se a requisição atual parte de um Super Admin autenticado.
 *
 * A autorização é confirmada por DUAS fontes (basta UMA delas):
 *  1. `user.user_metadata.role === 'super_admin'` — carregado no JWT da sessão
 *     (consulta rápida, sem I/O de banco).
 *  2. Tabela `public.profiles` lida com a **service role key** (ignora RLS),
 *     evitando que políticas de RLS causem um falso-negativo no servidor.
 *
 * @param deniedMessage Mensagem retornada no 403 quando não é Super Admin.
 */
export async function requireSuperAdmin(
  deniedMessage: string
): Promise<SuperAdminGuard> {
  // 1) Cliente com a sessão do requisitante (anon + cookies) só para ler o JWT.
  const supabase = await createClient();

  // 2) Identifica quem está chamando a API.
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

  // 3) Fonte 1 (rápida): papel declarado nos metadados do JWT.
  const isSuperAdminByMeta = user.user_metadata?.role === "super_admin";
  if (isSuperAdminByMeta) {
    return { ok: true, user };
  }

  // 4) Fonte 2 (authority): tabela `profiles` via service role (bypass de RLS).
  //    `maybeSingle` evita erro quando a linha de perfil ainda não existe.
  const adminClient = createAdminClient();
  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role === "super_admin") {
    return { ok: true, user };
  }

  return {
    ok: false,
    response: NextResponse.json({ error: deniedMessage }, { status: 403 }),
  };
}

/**
 * ⚠️ Nota de segurança:
 * `user_metadata` pode, por padrão, ser alterado pelo próprio usuário
 * (`supabase.auth.updateUser`). Confiar nele para autorização abre uma brecha
 * de escalonamento de privilégio. Ele é aceito aqui a pedido do requisitante
 * (robustez contra bloqueios de RLS/perpil ausente). Para endurecer, mova o
 * papel para `app_metadata` (editável apenas via service role) e passe a
 * consultar `user.app_metadata.role`.
 */
