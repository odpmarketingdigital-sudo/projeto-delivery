import { redirect } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { hasEstablishmentForUser } from "@/lib/supabase/establishments";
import { createAdminClient, createClient } from "@/lib/supabase/server";

/** Onboarding: única tela onde uma conta sem loja consegue criar a loja. */
const ONBOARDING_PATH = "/completar-cadastro";

/**
 * Recuperação de contas autenticadas **sem estabelecimento** no `/painel`.
 *
 * Chamada pelo `app/painel/layout.tsx` (Server Component), portanto vale para
 * `/painel` e todas as subrotas (`/painel/produtos`, `/painel/pedidos`…). É a
 * rede de proteção do onboarding: mesmo que o usuário chegue ao painel por um
 * link direto, `/auth/callback` antigo ou metadata desatualizada, ele só entra
 * se a loja existir de fato — sem isso encontraria apenas avisos do tipo
 * "Nenhum estabelecimento associado à sua conta", sem ação possível na tela.
 *
 * Regras:
 *  - sem sessão → nada a fazer (o middleware manda para `/login`);
 *  - `super_admin` → não tem loja por definição; segue para `/painel/admin`;
 *  - papel desconhecido → não desvia (evita mandar super admin ao onboarding);
 *  - loja **visível para a sessão** (mesma consulta da UI) → segue;
 *  - erro de leitura → *fail-open* (o painel mostra o próprio aviso);
 *  - nenhuma loja (confirmado) → `/completar-cadastro?erro=loja_ausente`.
 *
 * O destino reconsulta o banco e devolve ao painel quando a loja existe, então
 * o desvio nunca entra em laço.
 */
export async function ensurePainelStore(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return;

  const role = await resolveRole(supabase, user);

  if (role === null) return;
  if (role === "super_admin") return;

  // Fonte da verdade da interface: o mesmo cliente (RLS
  // `establishments_select_own`) usado por `useEstablishment` no painel.
  const visible = await hasEstablishmentForUser(supabase, user.id);

  if (visible === true) return;
  if (visible === null) return;

  // Nada visível pela sessão. Antes de desviar, confirma com a service role
  // (bypass de RLS): quem tem loja não pode ser expulso por política mal
  // configurada nem por falha momentânea de leitura.
  const authoritative = await storeViaServiceRole(user.id);

  if (authoritative === true) {
    console.error(
      "[painel] a loja do usuário existe mas não está visível para a sessão — revise as políticas de RLS de `establishments`",
      { userId: user.id }
    );
    return;
  }

  console.warn(
    "[painel] usuário autenticado sem estabelecimento — indo para o onboarding",
    { userId: user.id }
  );

  redirect(`${ONBOARDING_PATH}?erro=loja_ausente`);
}

/**
 * Papel do usuário (`admin`, `super_admin`…) — `null` quando não dá para saber.
 *
 * Metadados do JWT primeiro (consulta sem I/O); em seguida `profiles` pela
 * sessão e, se a leitura falhar, pela service role.
 */
async function resolveRole(
  supabase: SupabaseClient,
  user: User
): Promise<string | null> {
  const fromMetadata = user.user_metadata?.role;

  if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
    return fromMetadata;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!error) {
    const role = (data as { role?: string | null } | null)?.role;
    return typeof role === "string" && role.length > 0 ? role : null;
  }

  try {
    const { data: adminData } = await createAdminClient()
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    const role = (adminData as { role?: string | null } | null)?.role;
    return typeof role === "string" && role.length > 0 ? role : null;
  } catch (adminError) {
    console.error("[painel] falha ao resolver o papel do usuário", adminError, {
      userId: user.id,
    });
    return null;
  }
}

/** Confirma a existência da loja ignorando RLS (`null` = não foi possível). */
async function storeViaServiceRole(userId: string): Promise<boolean | null> {
  try {
    return await hasEstablishmentForUser(createAdminClient(), userId);
  } catch (error) {
    console.error("[painel] falha ao confirmar a loja com a service role", error, {
      userId,
    });
    return null;
  }
}
