import Link from "next/link";
import { Icon } from "./LandingIcons";
import { SUPPORT_WHATSAPP_DISPLAY, SUPPORT_WHATSAPP_URL } from "./contact";

/**
 * Preço de lançamento. O valor "cheio" aparece riscado para evidenciar o
 * desconto; o checkout continua lendo o preço real de `system_settings`, então
 * ao encerrar a promoção basta atualizar estas constantes e o painel.
 */
const REGULAR_PRICE_LABEL = "R$ 49,90";
const PROMO_PRICE_LABEL = "R$ 29,90";
const MONTHLY_SAVINGS_LABEL = "R$ 20,00";
const DISCOUNT_LABEL = "-40%";

const PLAN_BENEFITS = [
  "30 dias grátis para testar, sem cartão de crédito",
  "Sem taxas por pedido — 0% de comissão",
  "Painel completo com pedidos em tempo real",
  "Cardápio digital com a sua marca e seu link",
  "Cupons de desconto e dashboard de vendas",
  "Gestão de clientes, histórico e ticket médio",
  "Impressão térmica (58 mm e 80 mm)",
  "Suporte e treinamento no WhatsApp",
];

/**
 * Seção de preços: valor normal riscado, valor promocional em destaque e a
 * lista de tudo o que está incluso no plano único.
 */
export function Pricing() {
  return (
    <section
      id="planos"
      className="relative scroll-mt-24 overflow-hidden py-20 sm:py-24"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-amber-500/[0.08] blur-3xl"
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">
            <span className="h-px w-6 bg-amber-400/60" />
            Planos
            <span className="h-px w-6 bg-amber-400/60" />
          </span>
          <h2 className="mt-4 text-balance text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl">
            Um plano único, sem comissão e sem surpresa
          </h2>
          <p className="mt-4 text-pretty text-base leading-relaxed text-gray-400">
            Todos os recursos do Ipepper em um valor mensal fixo. Você vende
            mais e paga menos do que uma única taxa de marketplace.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-5xl">
          <div className="relative overflow-hidden rounded-[2rem] border border-amber-400/25 bg-[#0b1017] p-6 shadow-2xl shadow-amber-500/10 sm:p-10">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-amber-400/10 blur-3xl"
            />

            <div className="relative grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/25 bg-amber-400/[0.08] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-amber-200">
                  <Icon name="bolt" className="h-3.5 w-3.5" />
                  Oferta de lançamento
                </span>

                <p className="mt-6 flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-500">
                  <span className="line-through decoration-rose-400/70 decoration-2">
                    {REGULAR_PRICE_LABEL}/mês
                  </span>
                  <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
                    {DISCOUNT_LABEL}
                  </span>
                </p>

                <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-5xl font-black tracking-[-0.04em] text-white sm:text-6xl">
                    {PROMO_PRICE_LABEL}
                  </span>
                  <span className="text-base font-bold text-gray-400">/mês</span>
                </p>

                <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-400/[0.08] px-3 py-1.5 text-xs font-bold text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
                  <Icon name="check" className="h-3.5 w-3.5" />
                  Economize {MONTHLY_SAVINGS_LABEL} por mês
                </p>

                <p className="mt-4 max-w-md text-sm leading-relaxed text-gray-400">
                  Preço promocional de lançamento para os primeiros
                  estabelecimentos. Depois, o valor volta para{" "}
                  {REGULAR_PRICE_LABEL} por mês.
                </p>

                <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                  <Link
                    href="/cadastro"
                    className="group inline-flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-6 py-3.5 text-sm font-black text-gray-950 shadow-xl shadow-amber-500/25 transition hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
                  >
                    Começar 30 dias grátis
                    <Icon
                      name="arrowRight"
                      className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                  <a
                    href={SUPPORT_WHATSAPP_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3.5 text-sm font-bold text-white transition hover:border-white/25 hover:bg-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
                  >
                    <Icon name="whatsapp" className="h-4 w-4 text-emerald-400" />
                    Tirar dúvidas
                  </a>
                </div>

                <p className="mt-4 text-xs leading-relaxed text-gray-500">
                  Cancele quando quiser, sem fidelidade. Atendimento humano no
                  WhatsApp {SUPPORT_WHATSAPP_DISPLAY}.
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-gray-400">
                  Tudo incluído no plano
                </p>
                <ul className="mt-4 space-y-3">
                  {PLAN_BENEFITS.map((benefit) => (
                    <li key={benefit} className="flex gap-2.5">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400 ring-1 ring-inset ring-emerald-400/20">
                        <Icon name="check" className="h-3 w-3" />
                      </span>
                      <span className="text-sm leading-snug text-gray-300">
                        {benefit}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
