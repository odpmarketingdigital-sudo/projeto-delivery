import { Icon } from "./LandingIcons";
import { SUPPORT_WHATSAPP_DISPLAY, SUPPORT_WHATSAPP_URL } from "./contact";

/**
 * Botão flutuante de WhatsApp oficial exibido em toda a landing.
 *
 * O rótulo é escondido no mobile (onde o espaço é curto) e a ação continua
 * disponível pelo ícone, sempre com `aria-label` descritivo.
 */
export function FloatingWhatsApp() {
  return (
    <a
      href={SUPPORT_WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Falar no WhatsApp oficial do Ipepper: ${SUPPORT_WHATSAPP_DISPLAY}`}
      title={`WhatsApp ${SUPPORT_WHATSAPP_DISPLAY}`}
      className="group fixed bottom-5 right-5 z-50 inline-flex items-center gap-2.5 rounded-full bg-[#25D366] px-4 py-3 text-sm font-bold text-gray-950 shadow-2xl shadow-emerald-500/30 ring-1 ring-inset ring-white/30 transition hover:bg-[#20bd5a] focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 motion-reduce:transition-none"
    >
      <Icon name="whatsapp" className="h-5 w-5" />
      <span className="hidden pr-0.5 sm:inline">Fale no WhatsApp</span>
    </a>
  );
}
