import { Suspense } from "react";
import type { Metadata } from "next";
import Storefront from "../components/Storefront";

/**
 * Cardápio demonstrativo (`/demo`).
 *
 * Reutiliza o mesmo `Storefront` da rota por slug. Sem `slug`, a API
 * `/api/menu` devolve a primeira loja ativa — ideal para apresentar a vitrine
 * a partir da Landing Page. Query strings (`?slug=` / `?establishment_id=`)
 * continuam funcionando.
 */
export const metadata: Metadata = {
  title: "Cardápio Demonstração",
  description:
    "Veja uma vitrine Ipepper em funcionamento: produtos, adicionais, cupom e checkout direto no WhatsApp.",
  robots: {
    index: false,
    follow: true,
  },
};

export default function DemoPage() {
  return (
    // O Storefront usa `new Date()` para calcular Aberto/Fechado. Com Cache
    // Components, o Suspense permite pré-renderizar o fallback e concluir a
    // vitrine no cliente, sem gravar um horário fixo no HTML estático.
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
          <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-gray-300 border-t-yellow-400 dark:border-gray-700" />
        </div>
      }
    >
      <Storefront />
    </Suspense>
  );
}
