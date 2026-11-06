import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import Storefront from "../components/Storefront";
import { StoreUnavailable } from "../components/StoreUnavailable";
import { resolvePublicStore } from "@/lib/storeAvailability";

/**
 * Cardápio público por slug — rota dinâmica `/[slug]`.
 *
 * Cada estabelecimento possui uma URL exclusiva e amigável (ex.: `/la-fuego`).
 * Este Server Component captura o `slug` da URL e decide o que renderizar:
 *
 *  - loja `ativo` e com a assinatura em dia → `<Storefront>` (cardápio);
 *  - loja `inativo` ou com `subscription_status = 'canceled'` → página
 *    amigável "loja fora do ar" (`<StoreUnavailable>`), com o nome da loja.
 *    Cardápio, produtos e checkout ficam inacessíveis;
 *  - slug inexistente → 404 (`notFound()`).
 *
 * A regra vive em `lib/storeAvailability.ts` e é compartilhada com as rotas
 * que alteram o status (`/api/billing/cancel`, webhook do Asaas, painel).
 *
 * Observação: rotas estáticas de primeiro nível (`/painel`, `/login`,
 * `/checkout`, `/api/...`) têm precedência sobre esta rota dinâmica no
 * Next.js, portanto não são capturadas por `[slug]`.
 */

// O slug é validado em runtime (não existe `generateStaticParams` porque as
// lojas nascem a qualquer momento), então cada acesso consulta o banco.
// `instant = false` desliga a validação de navegação instantânea do segmento —
// mesmo padrão de `app/[slug]/checkout/page.tsx`.
export const instant = false;

interface PageProps {
  /** No Next 15+, `params` é uma Promise. */
  params: Promise<{ slug: string }>;
}

/**
 * `generateMetadata` e a página consultam o mesmo slug na mesma requisição:
 * o `cache` do React garante uma única ida ao banco.
 */
const resolveStore = cache(resolvePublicStore);

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await resolveStore(slug);

  if (store.state === "missing") {
    return {
      title: "Cardápio não encontrado",
      robots: { index: false, follow: false },
    };
  }

  // Loja fora do ar: não indexar (o link pode ser reativado a qualquer
  // momento) e manter o nome para o compartilhamento não ficar genérico.
  if (store.state === "offline") {
    return {
      title: store.name ? `${store.name} · Indisponível` : "Loja indisponível",
      description:
        "Este estabelecimento está temporariamente indisponível no momento.",
      robots: { index: false, follow: false },
    };
  }

  return {
    title: `${store.name} · Cardápio`,
    description: `Peça online de ${store.name}. Veja o cardápio, monte seu pedido e finalize pelo WhatsApp.`,
  };
}

export default async function SlugStorefrontPage({ params }: PageProps) {
  const { slug } = await params;

  const store = await resolveStore(slug);

  // Slug inexistente → 404.
  if (store.state === "missing") notFound();

  // Loja desativada (manual ou por cancelamento da assinatura): sem cardápio.
  if (store.state === "offline") {
    return <StoreUnavailable storeName={store.name} />;
  }

  return <Storefront slug={slug} />;
}
