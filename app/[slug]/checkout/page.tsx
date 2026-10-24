import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CheckoutForm } from "@/app/components/CheckoutForm";
import { createAdminClient } from "@/lib/supabase/server";

export const instant = false;

interface PageProps {
  params: Promise<{ slug: string }>;
}

async function resolveActiveStore(
  slug: string
): Promise<{ id: string; name: string } | null> {
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("establishments")
    .select("id, name")
    .eq("slug", slug)
    .eq("status", "ativo")
    .limit(1)
    .maybeSingle();
  if (error || !data || typeof data !== "object") return null;
  const row = data as { id?: unknown; name?: unknown };
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  return { id: row.id, name: row.name };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await resolveActiveStore(slug);
  if (!store) return { title: "Checkout não encontrado" };
  return { title: `Finalizar pedido · ${store.name}` };
}

export default async function SlugCheckoutPage({ params }: PageProps) {
  const { slug } = await params;
  const store = await resolveActiveStore(slug);
  if (!store) notFound();
  return <CheckoutForm slug={slug} />;
}
