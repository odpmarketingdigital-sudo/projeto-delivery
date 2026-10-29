import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfirmEmailPanel } from "./ConfirmEmailPanel";

/**
 * Tela de aviso da confirmação de e-mail (`/confirmar-email`).
 *
 * Para onde o middleware e o `PainelGuard` mandam quem tem sessão mas ainda não
 * confirmou o endereço (`auth.users.email_confirmed_at` nulo). Também é o
 * destino do cadastro quando o Supabase exige confirmação — nesse caso o
 * usuário chega sem sessão, com `?email=` para facilitar o reenvio.
 */
export const metadata: Metadata = {
  title: "Confirme seu e-mail — Ipepper",
  description:
    "Confirme o seu e-mail para liberar o acesso ao painel do Ipepper.",
  robots: { index: false, follow: false },
};

interface ConfirmarEmailPageProps {
  searchParams: Promise<{ email?: string | string[]; erro?: string | string[] }>;
}

/**
 * Lê `searchParams` dentro do boundary do Suspense: com Cache Components
 * (Next 16) esse acesso é dinâmico e não pode bloquear o prerender da rota.
 */
async function ConfirmarEmailContent({
  searchParams,
}: ConfirmarEmailPageProps) {
  const params = await searchParams;
  const rawEmail = Array.isArray(params.email) ? params.email[0] : params.email;
  const rawErro = Array.isArray(params.erro) ? params.erro[0] : params.erro;

  return (
    <ConfirmEmailPanel
      defaultEmail={rawEmail ?? ""}
      /* `?erro=link-invalido` vem de `/auth/callback` (link expirado). */
      linkInvalid={rawErro === "link-invalido"}
    />
  );
}

export default function ConfirmarEmailPage({
  searchParams,
}: ConfirmarEmailPageProps) {
  return (
    /* Fallback = a própria tela sem e-mail pré-preenchido. */
    <Suspense fallback={<ConfirmEmailPanel />}>
      <ConfirmarEmailContent searchParams={searchParams} />
    </Suspense>
  );
}
