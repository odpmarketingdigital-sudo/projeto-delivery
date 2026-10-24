"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

/**
 * Botão de logout reutilizável para o cabeçalho do painel.
 * Encerra a sessão do Supabase e redireciona para a tela de login.
 */
export function LogoutButton() {
  const router = useRouter();
  const { signOut, currentUser } = useAuth();

  const handleLogout = async () => {
    await signOut();
    router.replace("/login");
    router.refresh();
  };

  const firstName = currentUser?.name?.split(" ")[0] ?? "";

  return (
    <div className="flex items-center gap-2">
      {currentUser && (
        <span className="hidden text-sm font-medium text-gray-400 sm:inline">
          Olá, {firstName}
        </span>
      )}
      <button
        type="button"
        onClick={handleLogout}
        className="inline-flex items-center gap-1.5 rounded-full border border-gray-700 px-3 py-1.5 text-sm font-semibold text-gray-300 transition hover:border-red-500/50 hover:text-red-400 focus:outline-none focus:ring-2 focus:ring-red-500/40"
      >
        <span aria-hidden>⏻</span>
        Sair
      </button>
    </div>
  );
}

