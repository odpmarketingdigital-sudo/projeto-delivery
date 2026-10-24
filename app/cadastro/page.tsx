import type { Metadata } from "next";
import { SignupForm } from "./SignupForm";

/**
 * Cadastro público (onboarding self-service).
 *
 * Server Component: apenas define metadata/SEO e delega o formulário ao Client
 * Component `SignupForm`, que conversa com `/api/signup` e com o Supabase Auth
 * (login automático após a criação da conta).
 */
export const metadata: Metadata = {
  title: "Criar conta grátis — Ipepper",
  description:
    "Crie seu cardápio digital em minutos, receba pedidos organizados no WhatsApp e teste o Ipepper por 30 dias grátis, sem cartão de crédito.",
};

export default function CadastroPage() {
  return <SignupForm />;
}
