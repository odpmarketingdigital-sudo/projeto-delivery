"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

/**
 * Botão de logout reutilizável para o painel.
 * Encerra a sessão do Supabase e redireciona para a tela de login.
 *
 * `variant="dark"` atende a sidebar escura (#0d0f12); `variant="light"`
 * (padrão) é usado nas telas claras do painel.
 */
export function LogoutButton({
  variant = "light",
}: {
  variant?: "light" | "dark";
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
        className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-red-500/40 ${
          isDark
            ? "w-full border-white/15 text-slate-300 hover:border-red-400/60 hover:text-red-300"
            : "border-slate-300 text-slate-700 hover:border-red-400 hover:text-red-600"
        }`}
      >
        <span aria-hidden>⏻</span>
        Sair
      </button>
    </div>
  );
}

