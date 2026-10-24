import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * Cliente Supabase para uso em Server Components, Server Actions e
 * Route Handlers. Propagua a sessão do usuário através dos cookies.
 *
 * Em Server Components a escrita de cookies pode falhar (o middleware
 * é o responsável por renovar a sessão), por isso o `setAll` é tolerante
 * a erros nesse contexto.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignorado: em Server Components os cookies são read-only.
            // O middleware garante a renovação da sessão.
          }
        },
      },
    }
  );
}

/**
 * Cliente Supabase privilegiado (service role) para uso EXCLUSIVO no
 * servidor (Route Handlers / Server Actions). Ignora RLS e permite
 * operações administrativas, como criar usuários.
 *
 * ⚠️ NUNCA exponha a SUPABASE_SERVICE_ROLE_KEY no cliente. Este módulo
 * só deve ser importado por código que rode no servidor.
 */
export function createAdminClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
