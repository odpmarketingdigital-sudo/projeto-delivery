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
        <div className="relative overflow-hidden rounded-[2rem] border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white px-6 py-10 shadow-xl shadow-emerald-500/10 sm:px-10 sm:py-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-emerald-400/15 blur-3xl"
          />

          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/70 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-700">
                <Icon name="whatsapp" className="h-3.5 w-3.5" />
                Suporte humano
              </span>
              <h2 className="mt-4 text-balance text-2xl font-black tracking-[-0.03em] text-gray-900 sm:text-3xl">
                Precisa de ajuda para começar? Agende um Treinamento!
              </h2>
              <p className="mt-3 text-pretty text-sm leading-relaxed text-gray-600 sm:text-base">
                Nosso time acompanha você do primeiro cadastro ao primeiro
                pedido. A conversa é pelo WhatsApp oficial, sem robô e sem
                custo extra.
              </p>

              <ul className="mt-5 grid gap-2 sm:grid-cols-3">
                {TRAINING_STEPS.map((step) => (
                  <li
                    key={step}
                    className="flex items-start gap-2 rounded-xl border border-gray-200 bg-white p-3 text-xs leading-snug text-gray-700"
                  >
                    <Icon
                      name="check"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
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
                className="group inline-flex w-full items-center justify-center gap-2.5 rounded-xl bg-emerald-500 px-6 py-4 text-sm font-black text-gray-900 shadow-xl shadow-emerald-500/25 transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
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
