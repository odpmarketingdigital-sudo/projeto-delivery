"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Cliente Supabase para uso em Client Components (navegador).
 *
 * Gerencia a sessão via cookies, permitindo que o middleware e os
 * Server Components leiam a autenticação. Use este cliente dentro de
 * componentes marcados com "use client".
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
