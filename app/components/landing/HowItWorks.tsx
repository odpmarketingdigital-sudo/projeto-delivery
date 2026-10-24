import type { ReactNode } from "react";
import { Icon, type IconName } from "./LandingIcons";

interface Step {
  number: string;
  icon: IconName;
  title: string;
  description: string;
  detail: ReactNode;
}

const STEPS: Step[] = [
  {
    number: "01",
    icon: "whatsapp",
    title: "Cliente chama no WhatsApp",
    description:
      "O cliente envia uma mensagem para o seu estabelecimento, como já faz todos os dias.",
    detail: (
      <div className="flex items-center gap-2 rounded-xl rounded-tl-sm bg-emerald-400/[0.08] p-2.5 ring-1 ring-inset ring-emerald-400/15">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300">
          <Icon name="whatsapp" className="h-3.5 w-3.5" />
        </span>
        <p className="text-[11px] text-gray-300">Oi! Quero fazer um pedido 🍔</p>
      </div>
    ),
  },
  {
    number: "02",
    icon: "link",
    title: "Resposta automática",
    description:
      "O seu WhatsApp envia o link do cardápio digital Ipepper em segundos, sem atendimento manual.",
    detail: (
      <div className="flex items-center gap-2 rounded-xl bg-amber-400/[0.08] p-2.5 ring-1 ring-inset ring-amber-400/20">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
          <Icon name="link" className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-[9px] font-semibold text-gray-400">
            Cardápio digital
          </p>
          <p className="truncate text-[11px] font-bold text-amber-200">
            ipepper.com.br/la-fuego
          </p>
        </div>
      </div>
    ),
  },
  {
    number: "03",
    icon: "clipboard",
    title: "Pedido pronto no balcão",
    description:
      "O cliente escolhe os itens, insere o cupom, escolhe a entrega e o pedido cai diretamente no seu painel — pronto para imprimir e preparar.",
    detail: (
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-inset ring-white/10">
        {["NOVO", "PREPARANDO", "PRONTO"].map((status, index) => (
          <span
            key={status}
            className={`rounded-full px-2 py-1 text-[9px] font-bold ${
              index === 0
                ? "bg-amber-400 text-gray-950"
                : index === 1
                  ? "bg-orange-400/15 text-orange-300"
                  : "bg-emerald-400/15 text-emerald-300"
            }`}
          >
            {status}
          </span>
        ))}
      </div>
    ),
  },
];

/**
 * Seção "Como Funciona": fluxo em três etapas, do primeiro "oi" ao pedido
 * impresso no balcão.
 */
export function HowItWorks() {
  return (
    <section
      id="como-funciona"
      className="relative scroll-mt-24 border-y border-white/[0.06] bg-[#080b10] py-20 sm:py-24"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-amber-500/[0.04] to-transparent"
      />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">
            <span className="h-px w-6 bg-amber-400/60" />
            Simples assim
            <span className="h-px w-6 bg-amber-400/60" />
          </span>
          <h2 className="mt-4 text-balance text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl">
            Do WhatsApp ao balcão em 3 passos
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-gray-400">
            Sem instalar aplicativo, sem digitar item por item e sem perder
            pedido no meio da conversa.
          </p>
        </div>

        <div className="relative mt-14 grid gap-5 lg:grid-cols-3">
          <div
            aria-hidden="true"
            className="absolute left-[16%] right-[16%] top-9 hidden h-px bg-gradient-to-r from-transparent via-amber-400/25 to-transparent lg:block"
          />

          {STEPS.map((step) => (
            <article
              key={step.number}
              className="group relative overflow-hidden rounded-2xl border border-white/10 bg-[#0b1017] p-6 transition duration-300 hover:-translate-y-1 hover:border-amber-400/30 hover:bg-[#0d131b]"
            >
              <span
                aria-hidden="true"
                className="absolute right-5 top-3 text-6xl font-black tracking-tighter text-white/[0.035]"
              >
                {step.number}
              </span>

              <div className="relative flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300 ring-1 ring-inset ring-amber-400/20 transition group-hover:bg-amber-400/15">
                  <Icon name={step.icon} className="h-5 w-5" />
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                  Passo {step.number}
                </span>
              </div>

              <h3 className="relative mt-5 text-lg font-bold tracking-tight text-white">
                {step.title}
              </h3>
              <p className="relative mt-2 text-sm leading-relaxed text-gray-400">
                {step.description}
              </p>

              <div className="relative mt-5">{step.detail}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
