import { LandingHeader } from "./LandingHeader";
import { LandingHero } from "./LandingHero";
import { HowItWorks } from "./HowItWorks";
import { Features } from "./Features";
import { SystemGallery } from "./SystemGallery";
import { Benefits } from "./Benefits";
import { Testimonials } from "./Testimonials";
import { Pricing } from "./Pricing";
import { FinalCta } from "./FinalCta";
import { TrainingCta } from "./TrainingCta";
import { LandingFooter } from "./LandingFooter";
import { FloatingWhatsApp } from "./FloatingWhatsApp";

/**
 * Landing Page institucional do Ipepper.
 *
 * A página é sempre escura (independente do tema do sistema) para manter a
 * identidade visual da marca. As seções usam âncoras com `scroll-mt` para não
 * ficarem escondidas atrás do cabeçalho fixo: hero, como funciona, recursos,
 * galeria do sistema, planos, benefícios, depoimentos, CTA final e o convite
 * para agendar um treinamento (logo acima do rodapé).
 */
export function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-[#07090c] font-sans text-gray-100 antialiased selection:bg-amber-400 selection:text-gray-950">
      <a
        href="#conteudo"
        className="sr-only z-[60] rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-gray-950 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Pular para o conteúdo
      </a>

      <LandingHeader />

      <main id="conteudo">
        <LandingHero />
        <HowItWorks />
        <Features />
        <SystemGallery />
        <Pricing />
        <Benefits />
        <Testimonials />
        <FinalCta />
        <TrainingCta />
      </main>

      <LandingFooter />
      <FloatingWhatsApp />
    </div>
  );
}
