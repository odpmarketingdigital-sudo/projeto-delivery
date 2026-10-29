"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { AuthRole } from "@/context/AuthContext";
import { ForgotPasswordDialog } from "./ForgotPasswordDialog";

/** Rota de destino conforme o papel do usuário autenticado. */
function redirectForRole(role: AuthRole): string {
  return role === "super_admin" ? "/painel/admin" : "/painel";
}

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  /**
   * E-mail de uma conta que ainda não confirmou o endereço. Quando preenchido,
   * a tela mostra o atalho para `/confirmar-email` (reenvio do link).
   */
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  /** Controla o modal de recuperação de senha ("Esqueci minha senha"). */
  const [isForgotOpen, setForgotOpen] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    setError(null);
    setUnconfirmedEmail(null);
    setIsSubmitting(true);

    // 1) Autentica no Supabase Auth.
    const { data, error: signInError } = await supabase.auth.signInWithPassword(
      {
        email: email.trim(),
        password,
      }
    );

    if (signInError || !data.user) {
      setIsSubmitting(false);

      // Conta criada, mas sem o clique no link de confirmação: o GoTrue não
      // devolve sessão. Oferece o atalho para a tela de reenvio.
      if (signInError?.code === "email_not_confirmed") {
        setUnconfirmedEmail(email.trim());
        setError("Confirme o seu e-mail antes de acessar o painel.");
        return;
      }

      setError("E-mail ou senha incorretos.");
      return;
    }

    // Defesa extra: sessão criada com e-mail pendente (possível em projetos
    // com "Confirm email" desligado depois do cadastro). Encerra e avisa.
    if (!(data.user.email_confirmed_at ?? data.user.confirmed_at)) {
      await supabase.auth.signOut();
      setIsSubmitting(false);
      setUnconfirmedEmail(email.trim());
      setError("Confirme o seu e-mail antes de acessar o painel.");
      return;
    }

    // 2) Resolve o papel (role) do usuário.
    //    Usamos `.maybeSingle()`: quando não há linha em `profiles`, ele
    //    retorna `null` em vez de lançar erro (comportamento de `.single()`).
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .maybeSingle();

    // 3) Fallback para os metadados do Auth. Se a linha em `profiles` ainda
    //    não existir (ex.: trigger não executado), usamos o `role`/dados
    //    gravados em `user_metadata` na criação do usuário.
    const meta = data.user.user_metadata ?? {};
    const metaRole = typeof meta.role === "string" ? meta.role : undefined;
    const role = (profile?.role ?? metaRole) as AuthRole | undefined;

    if (role !== "super_admin" && role !== "admin") {
      // Sem papel válido conhecido: encerra a sessão de forma limpa para não
      // deixar um estado autenticado "preso" e evitar laços de redirecionamento.
      await supabase.auth.signOut();
      setIsSubmitting(false);
      setError(
        "Não foi possível carregar seu perfil de acesso. Verifique se seu usuário possui um perfil válido."
      );
      return;
    }

    setIsSubmitting(false);

    // 4) Redireciona conforme o papel.
    router.replace(redirectForRole(role));
    router.refresh();
  };

  const inputClass =
    "w-full rounded-xl border border-gray-700 bg-gray-800/60 px-3.5 py-2.5 text-sm text-white placeholder-gray-500 transition focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400";

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gray-950 px-4 py-10">
      {/* Brilho decorativo de fundo (tema Fuego) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(250,204,21,0.12),transparent_70%)]"
      />

      <div className="relative w-full max-w-md">
        {/* Marca */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-yellow-400 to-amber-500 text-2xl font-bold text-gray-950 shadow-lg shadow-yellow-400/20">
            🔥
          </span>
          <h1 className="mt-4 text-2xl font-bold text-white">
            Painel do Restaurante
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Acesse para gerenciar pedidos e o estabelecimento.
          </p>
        </div>

        {/* Cartão de login */}
        <div className="rounded-3xl border border-gray-800 bg-gray-900/80 p-6 shadow-2xl backdrop-blur-sm sm:p-8">
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-sm font-semibold text-gray-200"
              >
                E-mail
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                className={inputClass}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <label
                  htmlFor="password"
                  className="block text-sm font-semibold text-gray-200"
                >
                  Senha
                </label>
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="rounded text-xs font-semibold text-yellow-300 underline-offset-2 transition hover:text-yellow-200 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400/40"
                >
                  Esqueci minha senha
                </button>
              </div>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className={`${inputClass} pr-20`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-2 my-1 rounded-lg px-2.5 text-xs font-semibold text-gray-400 transition hover:text-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPassword ? "Ocultar" : "Mostrar"}
                </button>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-400"
              >
                {error}
              </p>
            )}

            {unconfirmedEmail && (
              <Link
                href={`/confirmar-email?email=${encodeURIComponent(unconfirmedEmail)}`}
                className="inline-flex w-full items-center justify-center rounded-xl border border-yellow-400/40 bg-yellow-400/10 px-4 py-2.5 text-sm font-semibold text-yellow-300 transition hover:bg-yellow-400/20 focus:outline-none focus:ring-2 focus:ring-yellow-400/40"
              >
                Reenviar e-mail de confirmação
              </Link>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-3 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? (
                <>
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth={4}
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  Entrando...
                </>
              ) : (
                "Entrar no Painel"
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          Ainda não tem conta?{" "}
          <Link
            href="/cadastro"
            className="font-semibold text-yellow-300 transition hover:text-yellow-200"
          >
            Criar conta grátis
          </Link>
        </p>

        <p className="mt-3 text-center text-sm text-gray-500">
          <Link
            href="/"
            className="font-medium text-gray-400 transition hover:text-yellow-300"
          >
            ← Voltar ao cardápio
          </Link>
        </p>
      </div>

      {isForgotOpen && (
        <ForgotPasswordDialog
          onClose={() => setForgotOpen(false)}
          defaultEmail={email}
        />
      )}
    </div>
  );
}
