import { connection } from "next/server";
import { resolvePainelEstablishmentId } from "@/lib/supabase/painelStoreGuard";
import { PainelAssinatura } from "./PainelAssinatura";

/**
 * Rota `/painel/assinatura` (Server Component).
 *
 * A loja ativa vem da **sessão** — resolvida por
 * `resolvePainelEstablishmentId()` — e não mais da query string. Era isso que
 * mantinha a URL carregando `?establishment_id=` em cada navegação: junto dos
 * cookies fatiados da sessão, o parâmetro empurrava a requisição para o limite
 * de headers e o servidor respondia `431 Request Header Fields Too Large`
 * antes de qualquer código rodar.
 *
 * Acessos antigos que ainda trazem `?establishment_id=` continuam funcionando:
 * o parâmetro é simplesmente **ignorado**. Nada de `redirect`/`NextResponse`
 * para "limpar" a URL e nada de regravar cookie de sessão no render — cada
 * correção de URL no servidor realimentava o ciclo de `Set-Cookie` do
 * middleware, que é justamente o que inflava o header.
 *
 * O `await connection()` marca o segmento como dinâmico antes da leitura de
 * cookies; sem ele o `GoTrueClient` é construído durante o prerender e o
 * auth-js chama `Date.now()` (rejeitado pelo Cache Components) — mesmo padrão
 * de `app/painel/layout.tsx` e `app/completar-cadastro/page.tsx`.
 */
export const instant = false;

export default async function AssinaturaPage() {
  await connection();

  const establishmentId = await resolvePainelEstablishmentId();

  return <PainelAssinatura establishmentId={establishmentId} />;
}
