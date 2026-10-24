import type { Metadata } from "next";
import { LandingPage } from "./components/landing/LandingPage";

/**
 * Página inicial do Ipepper.
 *
 * Renderiza a Landing Page institucional de forma estática. A vitrine
 * demonstrativa fica em `/demo` e os cardápios de cada estabelecimento
 * continuam disponíveis em `/[slug]`.
 */
export const metadata: Metadata = {
  title: "Ipepper — Cardápio digital para vender no WhatsApp",
  description:
    "Transforme seu WhatsApp em uma máquina de vendas: cardápio digital, pedidos organizados em tempo real, cupons, dashboard e clientes sem comissão por pedido.",
  applicationName: "Ipepper",
  keywords: [
    "cardápio digital",
    "delivery no WhatsApp",
    "pedidos online",
    "sistema para restaurantes",
    "delivery sem comissão",
    "Ipepper",
  ],
  openGraph: {
    title: "Ipepper — Cardápio digital para vender no WhatsApp",
    description:
      "Seu canal próprio de delivery: receba pedidos organizados no WhatsApp, sem comissão por pedido.",
    siteName: "Ipepper",
    locale: "pt_BR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Ipepper — Cardápio digital para vender no WhatsApp",
    description:
      "Seu canal próprio de delivery: receba pedidos organizados no WhatsApp, sem comissão por pedido.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function HomePage() {
  return <LandingPage />;
}
