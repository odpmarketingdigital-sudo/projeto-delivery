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
 * `?erro=<código>` (enviado pelo `/auth/callback` e pelo guard do painel) é
 * traduzido em um aviso no topo do formulário — ver `ONBOARDING_NOTICES`.
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
 * Avisos mostrados quando o usuário chega do `/auth/callback` sem a loja
 * criada (`?erro=`). Sem isso a tela apareceria vazia, como se ele tivesse
 * começado o cadastro do zero — e a pessoa não entenderia por que perdeu o que
 * digitou.
 */
const ONBOARDING_NOTICES: Record<string, string> = {
  rascunho_ausente:
    "Não encontramos os dados da loja que você preencheu antes de entrar com o Google (o rascunho dura 30 minutos e pode ter sido bloqueado pelo navegador). Confirme as informações abaixo para concluir o cadastro.",
  rascunho_nao_aplicado:
    "Não conseguimos criar sua loja automaticamente com os dados anteriores. Revise as informações abaixo e confirme para concluir o cadastro.",
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
 */
export const instant = false;

export default async function CompletarCadastroPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
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
