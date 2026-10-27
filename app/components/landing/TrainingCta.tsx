import { Icon } from "./LandingIcons";
import { SUPPORT_WHATSAPP_DISPLAY, TRAINING_WHATSAPP_URL } from "./contact";

const TRAINING_STEPS = [
  "Cadastro do cardápio e das categorias",
  "Configuração de adicionais, cupons e horários",
  "Treinamento do fluxo de pedidos e impressão",
];

/**
 * Convite para agendar um treinamento com o suporte, exibido no fim da página
 * (logo acima do rodapé). O botão abre o WhatsApp oficial com a mensagem de
 * agendamento já preenchida.
 */
export function TrainingCta() {
  return (
    <section id="treinamento" className="relative scroll-mt-24 pb-20 sm:pb-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-[2rem] border border-emerald-400/20 bg-gradient-to-br from-emerald-500/[0.12] via-[#0b1017] to-[#0b1017] px-6 py-10 shadow-2xl shadow-black/30 sm:px-10 sm:py-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-emerald-400/10 blur-3xl"
          />

          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-300">
                <Icon name="whatsapp" className="h-3.5 w-3.5" />
                Suporte humano
              </span>
              <h2 className="mt-4 text-balance text-2xl font-black tracking-[-0.03em] text-white sm:text-3xl">
                Precisa de ajuda para começar? Agende um Treinamento!
              </h2>
              <p className="mt-3 text-pretty text-sm leading-relaxed text-gray-400 sm:text-base">
                Nosso time acompanha você do primeiro cadastro ao primeiro
                pedido. A conversa é pelo WhatsApp oficial, sem robô e sem
                custo extra.
              </p>

              <ul className="mt-5 grid gap-2 sm:grid-cols-3">
                {TRAINING_STEPS.map((step) => (
                  <li
                    key={step}
                    className="flex items-start gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 text-xs leading-snug text-gray-300"
                  >
                    <Icon
                      name="check"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
                    />
                    {step}
                  </li>
                ))}
              </ul>
            </div>

            <div className="shrink-0 lg:max-w-xs">
              <a
                href={TRAINING_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex w-full items-center justify-center gap-2.5 rounded-xl bg-emerald-500 px-6 py-4 text-sm font-black text-gray-950 shadow-xl shadow-emerald-500/25 transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
              >
                <Icon name="whatsapp" className="h-5 w-5" />
                Agendar treinamento
                <Icon
                  name="arrowRight"
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                />
              </a>
              <p className="mt-3 text-center text-xs font-medium text-gray-500">
                WhatsApp oficial {SUPPORT_WHATSAPP_DISPLAY}
              </p>
              <p className="mt-1 text-center text-[11px] text-gray-600">
                Atendimento em horário comercial
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
