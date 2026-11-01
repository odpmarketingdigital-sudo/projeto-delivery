/**
 * Configuração pública do site.
 *
 * `SITE_URL` alimenta o `metadataBase` (canonical e Open Graph), o
 * `robots.txt` e o `sitemap.xml`.
 *
 * O padrão é `https://www.ipepper.com.br` — exatamente o endereço informado na
 * tela de consentimento OAuth e no Google Search Console. Se o domínio
 * canônico mudar (apex, staging), basta definir `NEXT_PUBLIC_SITE_URL` no
 * ambiente; nenhum arquivo precisa ser editado.
 *
 * Sem barra no final: os caminhos são concatenados como `${SITE_URL}/rota`.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.ipepper.com.br"
).replace(/\/+$/, "");
