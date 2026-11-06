import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { CartProvider } from "@/context/CartContext";
import { AuthProvider } from "@/context/AuthContext";
import { SITE_URL } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Ipepper — Cardápio digital para vender no WhatsApp",
  description:
    "Cardápio digital, pedidos em tempo real e gestão completa para transformar o WhatsApp em um canal de vendas sem comissão por pedido.",
  applicationName: "Ipepper",
  /**
   * Meta tag do Google Search Console (`<meta name="google-site-verification">`).
   * Preenchida apenas quando `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` existe no
   * ambiente — assim o valor fica fora do código e pode mudar por deploy.
   */
  ...(process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
    ? {
        verification: {
          google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
        },
      }
    : {}),
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/favicon.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /**
     * `suppressHydrationWarning` é usado APENAS aqui, onde é estritamente
     * necessário: `<html>` e `<body>` são os dois nós que extensões de
     * navegador, tradutores automáticos (Google Translate) e gerenciadores de
     * senha alteram (adicionando `class`, `style`, `data-*` ou `lang`) antes da
     * hidratação. Nenhum atributo nosso é dinâmico — o aviso suprimido é
     * somente o do próprio elemento (não afeta os filhos, que continuam
     * validados normalmente).
     */
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <AuthProvider>
          <CartProvider>{children}</CartProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
