/**
 * Contatos oficiais da Landing Page.
 *
 * Centralizar o número evita divergência entre o botão flutuante, o rodapé, a
 * seção de preços e o convite para o treinamento.
 */

/** Número oficial do suporte (DDI 55 + DDD 17 + número). */
export const SUPPORT_WHATSAPP_NUMBER = "5517992650460";

/** Número formatado para exibição ao lojista. */
export const SUPPORT_WHATSAPP_DISPLAY = "(17) 99265-0460";

/** Monta um link do WhatsApp com a mensagem já preenchida. */
export function whatsappLink(message: string): string {
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

/** Contato rápido: dúvidas sobre o Ipepper. */
export const SUPPORT_WHATSAPP_URL = whatsappLink(
  "Olá, gostaria de saber mais sobre o Ipepper"
);

/** Agendamento de treinamento com o time de suporte. */
export const TRAINING_WHATSAPP_URL = whatsappLink(
  "Olá! Gostaria de agendar um treinamento do Ipepper"
);
