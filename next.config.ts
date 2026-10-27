import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Origens autorizadas a consumir os recursos de desenvolvimento (`/_next/hmr`,
   * dev overlay). Sem isso, abrir o `next dev` por `127.0.0.1` ou pelo IP da
   * rede faz o Next bloquear o HMR como cross-origin — o Fast Refresh para de
   * funcionar e a página pode recarregar em loop enquanto o cliente tenta
   * reconectar. Afeta apenas o ambiente de desenvolvimento.
   */
  allowedDevOrigins: ["localhost", "127.0.0.1", "[::1]", "192.168.0.13"],
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
