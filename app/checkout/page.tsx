import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/server";
import { CheckoutForm } from "@/app/components/CheckoutForm";

export const instant = false;

/**
 * Rota legada `/checkout` — redireciona para `/[slug]/checkout` quando há
 * UM único estabelecimento ativo (caso comum de loja única); com várias
 * lojas, renderiza o checkout legado (loja resolvida pelo carrinho).
 */
export default async function CheckoutPage() {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from("establishments")
    .select("slug")
    .eq("status", "ativo")
    .limit(2);
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 1) {
    const only = rows[0] as { slug?: unknown };
    if (typeof only.slug === "string" && only.slug.trim()) {
      redirect(`/${only.slug.trim()}/checkout`);
    }
  }
  return <CheckoutForm />;
}
