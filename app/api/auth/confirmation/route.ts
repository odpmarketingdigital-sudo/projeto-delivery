import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/auth/confirmation
 *
 * Informa se o e-mail do usuário da sessão já foi confirmado.
 *
 * Existe porque o cliente não consegue distinguir com segurança "conta
 * pendente" de "informação ausente": o GoTrue **omite** `email_confirmed_at`
 * (e `confirmed_at`) quando a conta ainda não foi confirmada, então em
 * `session.user`/`getUser()` do browser o campo simplesmente não aparece. Aqui
 * a leitura é sempre no servidor, com o usuário completo.
 *
 * Resposta: `{ authenticated, email_confirmed }` com `Cache-Control: no-store`
 * (o estado muda assim que o usuário clica no link do e-mail).
 */
export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const noStore = { "Cache-Control": "no-store" };

  if (!user) {
    return NextResponse.json(
      { authenticated: false, email_confirmed: false },
      { headers: noStore }
    );
  }

  return NextResponse.json(
    {
      authenticated: true,
      email_confirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at),
    },
    { headers: noStore }
  );
}
