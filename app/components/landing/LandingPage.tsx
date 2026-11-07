import { LandingHeader } from "./LandingHeader";
import { LandingHero } from "./LandingHero";
import { HowItWorks } from "./HowItWorks";
import { Features } from "./Features";
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
 * A página usa um tema claro premium (fundo branco / cinza bem claro) com os
 * acentos de marca (amarelo/laranja e verde) nos botões e detalhes, garantindo
 * legibilidade e um visual moderno. As seções usam âncoras com `scroll-mt` para
 * não ficarem escondidas atrás do cabeçalho fixo: hero, como funciona, recursos,
 * planos, benefícios, depoimentos, CTA final e o convite para agendar um
 * treinamento (logo acima do rodapé).
 */
export function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-[#FAFAFA] font-sans text-gray-900 antialiased selection:bg-amber-400 selection:text-gray-900">
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
