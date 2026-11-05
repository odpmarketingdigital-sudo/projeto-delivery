import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "./ResetPasswordForm";

/**
 * Tela pública de criação de nova senha.
 *
 * O usuário chega aqui pelo link do e-mail de recuperação:
 * `/nova-senha?code=…` (PKCE) — o próprio formulário troca o código pela sessão
 * de recuperação. Links por `token_hash` passam pelo `/auth/callback`, que
 * autentica e abre esta tela. `?erro=link-invalido` sinaliza um link
 * expirado/já usado para que o formulário mostre um aviso em vez de um erro no
 * envio.
 */
export const metadata: Metadata = {
  title: "Criar nova senha — Ipepper",
  description:
    "Defina uma nova senha para voltar a acessar o painel do Ipepper com segurança.",
  robots: { index: false, follow: false },
};

interface NovaSenhaPageProps {
  searchParams: Promise<{
    erro?: string | string[];
    code?: string | string[];
  }>;
}

/**
 * Lê `searchParams` dentro do boundary do Suspense: com Cache Components
 * (Next 16) esse acesso é dinâmico e não pode bloquear o prerender da rota.
 */
async function NovaSenhaContent({ searchParams }: NovaSenhaPageProps) {
  const params = await searchParams;
  const rawError = Array.isArray(params.erro) ? params.erro[0] : params.erro;
  // `?code=` do link de recuperação (PKCE): trocado pelo próprio formulário.
  const recoveryCode = Array.isArray(params.code) ? params.code[0] : params.code;

  return (
    <ResetPasswordForm
      linkError={rawError === "link-invalido"}
      recoveryCode={recoveryCode}
    />
  );
}

export default function NovaSenhaPage({ searchParams }: NovaSenhaPageProps) {
  return (
    /* Fallback = a própria tela no estado "Validando link...", sem markup duplicado. */
    <Suspense fallback={<ResetPasswordForm />}>
      <NovaSenhaContent searchParams={searchParams} />
    </Suspense>
  );
}
