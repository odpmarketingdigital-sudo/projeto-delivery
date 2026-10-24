import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Middleware raiz: delega a renovação de sessão e a proteção de rotas
 * do painel ao helper `updateSession`.
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Aplica a todas as rotas exceto arquivos estáticos e imagens.
     * Mantém a sessão do Supabase sempre atualizada.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
