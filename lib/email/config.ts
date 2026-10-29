/**
 * Configuração do e-mail transacional do Ipepper (Resend).
 *
 * Server-side apenas: lê a chave secreta do provedor e resolve os valores
 * padrão usados pelos templates (remetente, URL pública, logotipo). Nenhum
 * Client Component deve importar este módulo.
 *
 * Variáveis de ambiente (ver `.env.local.example` e `docs/email-boas-vindas.md`):
 *  - `RESEND_API_KEY`     → chave da conta Resend (SECRETA)
 *  - `EMAIL_FROM`         → remetente; padrão `Ipepper <nao-responda@ipepper.com.br>`
 *  - `EMAIL_REPLY_TO`     → endereço de resposta/suporte (opcional)
 *  - `NEXT_PUBLIC_APP_URL`→ URL pública da plataforma (links dos e-mails)
 *  - `EMAIL_LOGO_URL`     → URL absoluta do logotipo do cabeçalho (opcional)
 */

/** Remetente oficial usado quando `EMAIL_FROM` não está definido. */
export const DEFAULT_EMAIL_FROM = "Ipepper <nao-responda@ipepper.com.br>";

/** URL pública da plataforma usada quando `NEXT_PUBLIC_APP_URL` não existe. */
export const DEFAULT_APP_URL = "https://ipepper.com.br";

/**
 * Logotipo servido pela própria aplicação (`public/logotipo-email.png`).
 *
 * É um PNG (rasterizado do `public/logotipo.svg`) porque clientes de e-mail
 * antigos — principalmente o Outlook para Windows, que renderiza com o motor do
 * Word — não exibem WebP, e o Gmail bloqueia SVG. O arquivo tem fundo
 * transparente e 480px de largura (2x a largura usada no template) para ficar
 * nítido em telas retina.
 */
export const DEFAULT_LOGO_PATH = "/logotipo-email.png";

/** Remove barras finais para concatenar caminhos sem duplicar a "/". */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Remetente do e-mail, sempre no formato `Nome <endereco@dominio>`.
 *
 * O domínio precisa estar verificado no Resend (Domains → Verify) — caso
 * contrário o provedor recusa o envio com `domain is not verified`.
 */
export function getEmailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM;
}

/** Endereço de resposta (aparece como "Responder para" no e-mail). */
export function getEmailReplyTo(): string | null {
  const value = process.env.EMAIL_REPLY_TO?.trim();
  return value || null;
}

/** URL pública da aplicação, sem barra final (ex.: `https://ipepper.com.br`). */
export function getAppUrl(): string {
  const value = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return trimTrailingSlash(value || DEFAULT_APP_URL);
}

/**
 * URL absoluta do logotipo do cabeçalho.
 *
 * Clientes de e-mail não resolvem caminhos relativos, por isso o template
 * nunca usa `/logotipo-email.png` diretamente.
 */
export function getEmailLogoUrl(): string {
  const override = process.env.EMAIL_LOGO_URL?.trim();
  if (override) return override;
  return `${getAppUrl()}${DEFAULT_LOGO_PATH}`;
}

/** `true` quando há chave do Resend configurada (usado por diagnósticos). */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}
