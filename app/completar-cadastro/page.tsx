import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { resolveOwnerName } from "@/lib/registration";
import { findEstablishmentForUser } from "@/lib/supabase/establishments";
import { createClient } from "@/lib/supabase/server";
import { CompleteSignupForm } from "./CompleteSignupForm";

/**
 * Onboarding obrigatório (`/completar-cadastro`) — **etapa 2 do cadastro**.
 *
 * A conta já existe (Google ou e-mail + senha), mas ainda não tem loja: o
 * Google não traz nome do estabelecimento, CPF/CNPJ, WhatsApp nem o link do
 * cardápio, e o cadastro por e-mail também não pede mais esses dados antes da
 * autenticação. Esta tela coleta tudo e envia para
 * `POST /api/signup/establishment`, que grava a loja com o `user_id` da sessão.
 *
 * Guards (no servidor):
 *  - sem sessão → `/login`;
 *  - conta que já tem estabelecimento → `/painel` (não há o que completar).
 *
 * `?erro=loja_ausente` (enviado pelo guard do painel) é traduzido em um aviso
 * no topo do formulário — ver `ONBOARDING_NOTICES`.
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
 * Aviso mostrado quando o usuário chega ao onboarding por uma rota protegida
 * (`?erro=loja_ausente`, enviado pelo guard do painel). Sem ele a tela
 * apareceria como se o cadastro tivesse começado do zero, e a pessoa não
 * entenderia por que foi trazida para cá.
 */
const ONBOARDING_NOTICES: Record<string, string> = {
  loja_ausente:
    "Sua conta ainda não tem um estabelecimento. Preencha os dados da loja para liberar o painel.",
};

/** Traduz `?erro=<código>` no texto do aviso (ou `null` quando não há). */
function signupNotice(
  params: Record<string, string | string[] | undefined>
): string | null {
  const raw = params.erro;
  const code = Array.isArray(raw) ? raw[0] : raw;

  return code ? (ONBOARDING_NOTICES[code] ?? null) : null;
}

/**
 * A tela lê `cookies()` (sessão do Supabase) no servidor, então não pode ser
 * pré-renderizada estaticamente — mesmo padrão de `app/painel/layout.tsx`.
 *
 * O `await connection()` é obrigatório antes de `createClient()`: sem ele o
 * `GoTrueClient` é construído durante o prerender e o auth-js chama
 * `Date.now()` ao carregar a sessão do cookie, o que o Cache Components
 * rejeita ("encountered the unstable value `Date.now()` while prerendering").
 */
export const instant = false;

export default async function CompletarCadastroPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  await connection();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?redirect=%2Fcompletar-cadastro");

  const establishment = await findEstablishmentForUser(supabase, user.id);
  if (establishment) redirect("/painel");

  const email = user.email ?? "";
  const ownerName = resolveOwnerName(user.user_metadata, email);

  return (
    <CompleteSignupForm
      email={email}
      initialOwnerName={ownerName}
      notice={signupNotice(params)}
    />
  );
}
