import { Icon } from "./LandingIcons";

const TESTIMONIALS = [
  {
    quote:
      "Antes eu perdia minutos digitando pedido no WhatsApp. Hoje o cliente recebe o link, monta o pedido e ele já cai no painel. Minha equipe só prepara e entrega.",
    name: "Rafael Menezes",
    role: "La Fuego Burger",
    initials: "RM",
    accent: "from-amber-400 to-orange-500",
  },
  {
    quote:
      "Não larguei o iFood. O Ipepper virou o nosso canal direto: o cliente que já fala com a gente no WhatsApp pede pelo link, sem comissão e com a nossa marca.",
    name: "Camila Rocha",
    role: "Cantina da Vila",
    initials: "CR",
    accent: "from-rose-400 to-orange-500",
  },
  {
    quote:
      "O dashboard mostra o dia mais fraco da semana. Consigo planejar promoção e estoque com antecedência, em vez de descobrir no fim do mês.",
    name: "Diego Santos",
    role: "Sabor do Norte",
    initials: "DS",
    accent: "from-emerald-400 to-teal-500",
  },
];

/**
 * Depoimentos de restaurantes que usam o canal próprio no WhatsApp.
 */
export function Testimonials() {
  return (
    <section
      id="depoimentos"
      className="relative scroll-mt-24 py-20 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">
            <span className="h-px w-6 bg-amber-400/60" />
            Depoimentos
            <span className="h-px w-6 bg-amber-400/60" />
          </span>
          <h2 className="mt-4 text-balance text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl">
            Quem vende no WhatsApp já sente a diferença
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-gray-400">
            Histórias de restaurantes que profissionalizaram o atendimento sem
            abrir mão dos aplicativos que já usam.
          </p>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {TESTIMONIALS.map((testimonial) => (
            <figure
              key={testimonial.name}
              className="group relative flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.025] p-6 transition duration-300 hover:border-amber-400/25 hover:bg-white/[0.04]"
            >
              <span
                aria-hidden="true"
                className="absolute right-6 top-3 font-serif text-6xl leading-none text-amber-400/10"
              >
                &ldquo;
              </span>

              <div
                className="flex items-center gap-0.5 text-amber-300"
                aria-label="Avaliação: 5 de 5 estrelas"
              >
                {Array.from({ length: 5 }).map((_, index) => (
                  <Icon key={index} name="star" className="h-3.5 w-3.5" />
                ))}
              </div>

              <blockquote className="relative mt-5 flex-1 text-sm leading-relaxed text-gray-300">
                &ldquo;{testimonial.quote}&rdquo;
              </blockquote>

              <figcaption className="mt-6 flex items-center gap-3 border-t border-white/[0.07] pt-5">
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${testimonial.accent} text-xs font-black text-gray-950`}
                  aria-hidden="true"
                >
                  {testimonial.initials}
                </span>
                <div>
                  <p className="text-sm font-bold text-white">
                    {testimonial.name}
                  </p>
                  <p className="text-xs text-gray-500">{testimonial.role}</p>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
