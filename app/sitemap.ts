import type { MetadataRoute } from "next";
import { LEGAL_LAST_UPDATED_ISO } from "@/app/components/legal/legalContent";
import { SITE_URL } from "@/lib/site";

/**
 * `sitemap.xml` gerado pelo App Router.
 *
 * Inclui apenas páginas públicas e indexáveis. As datas das páginas legais
 * vêm de `LEGAL_LAST_UPDATED_ISO`, então o sitemap acompanha automaticamente
 * a última revisão dos documentos.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const legalLastModified = new Date(LEGAL_LAST_UPDATED_ISO);

  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/privacidade`,
      lastModified: legalLastModified,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/termos`,
      lastModified: legalLastModified,
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];
}
