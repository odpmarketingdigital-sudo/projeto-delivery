import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "./ResetPasswordForm";

/**
 * Tela pública de criação de nova senha.
 *
 * O usuário chega aqui pelo link do e-mail de recuperação: o Supabase manda o
 * código para `/auth/callback`, que troca o código pela sessão de recuperação e
 * redireciona para cá. `?erro=link-invalido` sinaliza um link expirado/já usado
 * para que o formulário mostre um aviso em vez de um erro no envio.
 */
export const metadata: Metadata = {
  title: "Criar nova senha — Ipepper",
  description:
    "Defina uma nova senha para voltar a acessar o painel do Ipepper com segurança.",
  robots: { index: false, follow: false },
};

interface NovaSenhaPageProps {
  searchParams: Promise<{ erro?: string | string[] }>;
}

/**
 * Lê `searchParams` dentro do boundary do Suspense: com Cache Components
 * (Next 16) esse acesso é dinâmico e não pode bloquear o prerender da rota.
 */
async function NovaSenhaContent({ searchParams }: NovaSenhaPageProps) {
  const params = await searchParams;
  const rawError = Array.isArray(params.erro) ? params.erro[0] : params.erro;

  return <ResetPasswordForm linkError={rawError === "link-invalido"} />;
}

export default function NovaSenhaPage({ searchParams }: NovaSenhaPageProps) {
  return (
    /* Fallback = a própria tela no estado "Validando link...", sem markup duplicado. */
    <Suspense fallback={<ResetPasswordForm />}>
      <NovaSenhaContent searchParams={searchParams} />
    </Suspense>
  );
}
