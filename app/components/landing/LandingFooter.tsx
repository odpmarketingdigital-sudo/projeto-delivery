import Link from "next/link";
import { LandingBrand } from "./LandingBrand";
import { Icon, type IconName } from "./LandingIcons";
import { SUPPORT_WHATSAPP_DISPLAY, SUPPORT_WHATSAPP_URL } from "./contact";

const NAV_LINKS = [
  { href: "#inicio", label: "Início" },
  { href: "#como-funciona", label: "Como Funciona" },
  { href: "#recursos", label: "Recursos" },
  { href: "#sistema", label: "Sistema" },
  { href: "#planos", label: "Planos" },
  { href: "#beneficios", label: "Benefícios" },
  { href: "#depoimentos", label: "Depoimentos" },
  { href: "#treinamento", label: "Treinamento" },
];

const SOCIAL_LINKS: { href: string; label: string; icon: IconName }[] = [
  {
    href: "https://www.instagram.com/",
    label: "Instagram",
    icon: "instagram",
  },
  {
    href: "https://www.facebook.com/",
    label: "Facebook",
    icon: "facebook",
  },
  {
    href: SUPPORT_WHATSAPP_URL,
    label: `WhatsApp ${SUPPORT_WHATSAPP_DISPLAY}`,
    icon: "whatsapp",
  },
];

/**
 * Rodapé institucional da landing.
 */
export function LandingFooter() {
  return (
    <footer className="border-t border-white/[0.08] bg-[#05070a]">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_0.8fr_0.8fr]">
          <div className="max-w-sm">
            <LandingBrand />
            <p className="mt-4 text-sm leading-relaxed text-gray-500">
              O cardápio digital que transforma o WhatsApp em um canal de
              vendas direto, organizado e sem comissão por pedido.
            </p>
            <div className="mt-5 flex items-center gap-2">
              {SOCIAL_LINKS.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={social.label}
                  title={social.label}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-gray-400 transition hover:border-amber-400/30 hover:bg-amber-400/10 hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  <Icon name={social.icon} className="h-4 w-4" />
                </a>
              ))}
            </div>
          </div>

          <nav aria-label="Links do rodapé">
            <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-gray-300">
              Navegue
            </h3>
            <ul className="mt-4 space-y-2.5">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="text-sm text-gray-500 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-gray-300">
              Acesso rápido
            </h3>
            <ul className="mt-4 space-y-2.5">
              <li>
                <Link
                  href="/cadastro"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-300 transition hover:text-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  Criar conta grátis
                  <Icon name="arrowRight" className="h-3.5 w-3.5" />
                </Link>
              </li>
              <li>
                <Link
                  href="/painel"
                  className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  Acessar painel
                  <Icon name="arrowRight" className="h-3.5 w-3.5" />
                </Link>
              </li>
              <li>
                <Link
                  href="/demo"
                  className="text-sm text-gray-500 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  Cardápio demonstração
                </Link>
              </li>
              <li>
                <Link
                  href="/login"
                  className="text-sm text-gray-500 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  Entrar na minha conta
                </Link>
              </li>
              <li>
                <a
                  href={SUPPORT_WHATSAPP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                >
                  <Icon name="whatsapp" className="h-3.5 w-3.5 text-emerald-400" />
                  WhatsApp {SUPPORT_WHATSAPP_DISPLAY}
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-white/[0.08] pt-6 text-xs text-gray-600 sm:flex-row sm:items-center sm:justify-between">
          <p>© Ipepper. Todos os direitos reservados.</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-5">
            <p>Seu delivery, seu canal, seus clientes.</p>
            <a
              href="#inicio"
              className="inline-flex w-fit items-center gap-1.5 font-semibold text-gray-500 transition hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              Voltar ao topo
              <Icon name="arrowRight" className="h-3.5 w-3.5 -rotate-90" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
