import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveOwnerName } from "@/lib/registration";
import { findEstablishmentForUser } from "@/lib/supabase/establishments";
import { createClient } from "@/lib/supabase/server";
import { CompleteSignupForm } from "./CompleteSignupForm";

/**
 * Onboarding pós-OAuth (`/completar-cadastro`).
 *
 * O login com Google cria a conta em `auth.users`, mas não traz nome da loja,
 * CPF/CNPJ, WhatsApp nem o link do cardápio. Esta tela coleta esses dados e
 * envia para `POST /api/signup/establishment`.
 *
 * Guards (no servidor):
 *  - sem sessão → `/login`;
 *  - conta que já tem estabelecimento → `/painel` (não há o que completar).
 *
 * As demais checagens (e-mail confirmado, redirecionamentos) ficam no
 * middleware — ver `lib/supabase/middleware.ts`.
 */
export const metadata: Metadata = {
  title: "Complete seu cadastro — Ipepper",
  description:
    "Faltam poucos dados para publicar seu cardápio digital no Ipepper: nome da loja, documento, WhatsApp e link.",
  robots: { index: false, follow: false },
};

/**
 * A tela lê `cookies()` (sessão do Supabase) no servidor, então não pode ser
 * pré-renderizada estaticamente — mesmo padrão de `app/painel/layout.tsx`.
 */
export const instant = false;

export default async function CompletarCadastroPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?redirect=%2Fcompletar-cadastro");

  const establishment = await findEstablishmentForUser(supabase, user.id);
  if (establishment) redirect("/painel");

  const email = user.email ?? "";
  const ownerName = resolveOwnerName(user.user_metadata, email);

  return <CompleteSignupForm email={email} initialOwnerName={ownerName} />;
}
