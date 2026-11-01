import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * `robots.txt` gerado pelo App Router.
 *
 * Libera o conteúdo institucional (landing, Política de Privacidade e Termos
 * de Uso) — que é justamente o que o Google exige acessível publicamente na
 * verificação da marca — e bloqueia áreas privadas/transacionais.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/painel",
          "/checkout",
          "/completar-cadastro",
          "/confirmar-email",
          "/nova-senha",
          "/auth/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
