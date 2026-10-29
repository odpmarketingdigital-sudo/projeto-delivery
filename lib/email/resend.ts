import { Resend } from "resend";

/**
 * Cliente Resend (reaproveitado entre requisições do mesmo processo).
 *
 * A chave vem exclusivamente de `RESEND_API_KEY` — nunca é hardcoded nem
 * exposta ao navegador. Quando a variável está ausente devolvemos `null` para
 * que o chamador decida entre falhar de forma explícita (rota) ou apenas
 * registrar um aviso e seguir (cadastro).
 */
let client: Resend | null = null;

export function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;

  client ??= new Resend(apiKey);
  return client;
}
