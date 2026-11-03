import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CheckoutForm } from "@/app/components/CheckoutForm";
import { StoreUnavailable } from "@/app/components/StoreUnavailable";
import { resolvePublicStore } from "@/lib/storeAvailability";

export const instant = false;

interface PageProps {
  params: Promise<{ slug: string }>;
}

/** `generateMetadata` + página reaproveitam a mesma consulta na requisição. */
const resolveStore = cache(resolvePublicStore);

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await resolveStore(slug);

  if (store.state === "missing") return { title: "Checkout não encontrado" };
  if (store.state === "offline") {
    return {
      title: store.name
        ? `${store.name} · Indisponível`
        : "Loja indisponível",
      robots: { index: false, follow: false },
    };
  }

  return { title: `Finalizar pedido · ${store.name}` };
}

export default async function SlugCheckoutPage({ params }: PageProps) {
  const { slug } = await params;
  const store = await resolveStore(slug);

  if (store.state === "missing") notFound();

  // Acesso direto ao checkout de uma loja fora do ar: bloqueia também aqui
  // (o link pode ter sido salvo antes do cancelamento).
  if (store.state === "offline") {
    return <StoreUnavailable storeName={store.name} />;
  }

  return <CheckoutForm slug={slug} />;
}
