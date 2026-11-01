/**
 * Dados oficiais exibidos nas páginas legais (Política de Privacidade e
 * Termos de Uso).
 *
 * Centralizar aqui evita divergência entre as duas páginas e facilita a
 * atualização quando o canal de suporte ou a data de revisão mudarem.
 *
 * Observação: a Landing Page usa os contatos definidos em
 * `app/components/landing/contact.ts`. Se o canal oficial for unificado,
 * atualize os dois arquivos.
 */

/** Nome comercial da plataforma. */
export const PRODUCT_NAME = "Ipepper";

/** Empresa responsável pelo desenvolvimento e gestão da plataforma. */
export const COMPANY_NAME = "ODP Digital";

/** E-mail oficial de suporte, privacidade e cancelamento. */
export const SUPPORT_EMAIL = "contato@odpdigital.com.br";

/** Telefone/WhatsApp formatado para exibição. */
export const SUPPORT_PHONE_DISPLAY = "(17) 99265-0646";

/** Telefone no formato internacional (DDI 55 + DDD 17 + número). */
export const SUPPORT_PHONE_NUMBER = "5517992650646";

/** Data da última revisão dos documentos (ISO, para o atributo dateTime). */
export const LEGAL_LAST_UPDATED_ISO = "2026-10-31";

/** Data da última revisão em texto, exibida no cabeçalho das páginas. */
export const LEGAL_LAST_UPDATED_DISPLAY = "31 de outubro de 2026";

/** Monta um link do WhatsApp com a mensagem já preenchida. */
export function supportWhatsAppUrl(message: string): string {
  return `https://wa.me/${SUPPORT_PHONE_NUMBER}?text=${encodeURIComponent(message)}`;
}

/** Contato geral de suporte. */
export const SUPPORT_WHATSAPP_URL = supportWhatsAppUrl(
  `Olá! Preciso de ajuda com o ${PRODUCT_NAME}`
);

/** Contato específico para assuntos de privacidade e LGPD. */
export const PRIVACY_WHATSAPP_URL = supportWhatsAppUrl(
  `Olá! Tenho uma dúvida sobre a Política de Privacidade do ${PRODUCT_NAME}`
);
