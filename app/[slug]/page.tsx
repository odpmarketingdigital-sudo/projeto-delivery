import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Storefront from "../components/Storefront";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Cardápio público por slug — rota dinâmica `/[slug]`.
 *
 * Cada estabelecimento ativo possui uma URL exclusiva e amigável
 * (ex.: `/la-fuego`). Este Server Component captura o `slug` da URL, valida a
 * existência de uma loja ativa com esse slug e renderiza o `Storefront`, que
 * consulta `/api/menu?slug=...` e exibe o cardápio daquele restaurante.
 *
 * `generateMetadata` usa a mesma validação para definir o título por loja e
 * responder 404 (notFound) para slugs inexistentes/inativos — evita indexar
 * páginas inválidas e melhora o compartilhamento do link.
 *
 * Observação: rotas estáticas de primeiro nível (`/painel`, `/login`,
 * `/checkout`, `/api/...`) têm precedência sobre esta rota dinâmica no
 * Next.js, portanto não são capturadas por `[slug]`.
 */

// A validação do slug consulta o banco em runtime; como não há
// `generateStaticParams` (os slugs são dinâmicos), marcamos a rota como
// blocking para não tentar pré-renderizar estático — mesmo padrão de
// `app/painel/layout.tsx`.
export const instant = false;

interface PageProps {
  /** No Next 15+, `params` é uma Promise. */
  params: Promise<{ slug: string }>;
}

/** Linha mínima de `establishments` necessária para validar o slug. */
type EstablishmentNameRow = { name?: string | null };

/**
 * Resolve o nome da loja ativa dona do `slug`. Retorna `null` quando o slug
 * não existe ou o estabelecimento está inativo (→ 404 na página).
 */
async function resolveActiveStoreName(
  slug: string
): Promise<string | null> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("establishments")
    .select("name")
    .eq("slug", slug)
    .eq("status", "ativo")
    .limit(1)
    .maybeSingle<EstablishmentNameRow>();

  if (error || !data) return null;
  return data.name?.trim() || null;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const name = await resolveActiveStoreName(slug);
  if (!name) {
    return { title: "Cardápio não encontrado" };
  }
  return {
    title: `${name} · Cardápio`,
    description: `Peça online de ${name}. Veja o cardápio, monte seu pedido e finalize pelo delivery.`,
  };
}

export default async function SlugStorefrontPage({ params }: PageProps) {
  const { slug } = await params;

  // Valida a existência da loja ativa antes de renderizar (404 se inexistente).
  const name = await resolveActiveStoreName(slug);
  if (!name) notFound();

  return <Storefront slug={slug} />;
}
