"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

/**
 * Botão de logout reutilizável para o painel.
 * Encerra a sessão do Supabase e redireciona para a tela de login.
 *
 * `variant="dark"` atende a sidebar escura (#0d0f12); `variant="light"`
 * (padrão) é usado nas telas claras do painel.
 *
 * `compact` reduz o botão a um quadrado com o ícone de desligar — usado na
 * sidebar recolhida, onde não há espaço para o texto "Sair" (o nome acessível
 * vem de `aria-label`).
 */
export function LogoutButton({
  variant = "light",
  compact = false,
}: {
  variant?: "light" | "dark";
  /** Somente o ícone (sidebar recolhida). */
  compact?: boolean;
}) {
  const router = useRouter();
  const { signOut, currentUser } = useAuth();

  const handleLogout = async () => {
    await signOut();
    router.replace("/login");
    router.refresh();
  };

  const firstName = currentUser?.name?.split(" ")[0] ?? "";
  const isDark = variant === "dark";

  const sizeClassName = compact
    ? "h-9 w-9"
    : `px-3 py-1.5${isDark ? " w-full" : ""}`;
  const toneClassName = isDark
    ? "border-white/15 text-slate-300 hover:border-red-400/60 hover:text-red-300"
    : "border-slate-300 text-slate-700 hover:border-red-400 hover:text-red-600";

  return (
    <div className="flex items-center gap-2">
      {currentUser && !isDark && (
        <span className="hidden text-sm font-medium text-slate-600 sm:inline">
          Olá, {firstName}
        </span>
      )}
      <button
        type="button"
        onClick={handleLogout}
        aria-label={compact ? "Sair da conta" : undefined}
        title={compact ? "Sair da conta" : undefined}
        className={`inline-flex items-center justify-center gap-1.5 rounded-full border text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-red-500/40 ${sizeClassName} ${toneClassName}`}
      >
        <span aria-hidden>⏻</span>
        {compact ? null : "Sair"}
      </button>
    </div>
  );
}

