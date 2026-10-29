import { NextResponse } from "next/server";
import { renderWelcomeEmailFor } from "@/lib/email/welcome";
import { TRIAL_DAYS, addTrialDays } from "@/lib/subscriptions";

/**
 * GET /api/email/preview — pré-visualização do e-mail de boas-vindas.
 *
 * Renderiza o template com dados fictícios e devolve o HTML no navegador, sem
 * enviar nada pelo Resend. Útil para revisar o layout no Gmail/Outlook e para
 * conferir a marcação antes de publicar.
 *
 * Rota de desenvolvimento: responde 404 quando `NODE_ENV === "production"`,
 * porque não há motivo para expor o HTML do e-mail publicamente.
 *
 * Query opcional: `?nome=Dona%20Maria&loja=Maria%20Burgers&slug=maria-burgers`
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const { searchParams } = new URL(request.url);

  const email = await renderWelcomeEmailFor({
    to: "preview@ipepper.com.br",
    ownerName: searchParams.get("nome")?.trim() || "Maria Silva",
    establishmentName:
      searchParams.get("loja")?.trim() || "Maria Burgers & Cia",
    slug: searchParams.get("slug")?.trim() || "maria-burgers",
    trialDays: TRIAL_DAYS,
    trialEndsAt: addTrialDays(),
  });

  // `?formato=texto` mostra a alternativa em texto puro (clientes sem HTML).
  if (searchParams.get("formato") === "texto") {
    return new NextResponse(email.text, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return new NextResponse(email.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Email-Subject": encodeURIComponent(email.subject),
    },
  });
}
