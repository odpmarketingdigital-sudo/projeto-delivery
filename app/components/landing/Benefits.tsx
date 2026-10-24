import Link from "next/link";
import { BrandMark, Icon } from "./LandingIcons";

const BENEFITS = [
  {
    title: "Sem comissões por pedido",
    description:
      "O faturamento é 100% do restaurante. O cliente pede pelo seu link e o valor da venda fica inteiro com o seu negócio.",
  },
  {
    title: "Atendimento sem filas no WhatsApp",
    description:
      "Chega de digitar item por item na conversa. O cardápio apresenta as opções, calcula o total e organiza o pedido automaticamente.",
  },
  {
    title: "Base de clientes própria",
    description:
      "A lista e os dados de contato dos clientes pertencem ao seu negócio. Use o histórico para promoções e reengajamento.",
  },
];

const COMPARISON_ROWS = [
  { label: "Comissão por pedido", before: "Variável", after: "0%" },
  { label: "Atendimento no WhatsApp", before: "Manual", after: "Automático" },
  { label: "Base de clientes", before: "Da plataforma", after: "Sua" },
  { label: "Pedidos", before: "Espalhados", after: "1 painel" },
  { label: "Cardápio", before: "Layout padrão", after: "Sua marca" },
];

/**
 * Seção de benefícios com o comparativo entre depender só de um marketplace
 * e vender direto pelo canal próprio no WhatsApp.
 */
export function Benefits() {
  return (
    <section
      id="beneficios"
      className="relative scroll-mt-24 overflow-hidden border-y border-white/[0.06] bg-[#080b10] py-20 sm:py-24"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 top-1/3 h-80 w-80 rounded-full bg-amber-500/[0.07] blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-40 bottom-0 h-80 w-80 rounded-full bg-orange-500/[0.06] blur-3xl"
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:items-center lg:gap-16">
          <div>
            <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">
              <span className="h-px w-6 bg-amber-400/60" />
              Por que ter o Ipepper?
            </span>
            <h2 className="mt-4 text-balance text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl">
              Some forças com os apps. Não abra mão do seu canal.
            </h2>
            <p className="mt-4 text-pretty text-base leading-relaxed text-gray-400">
              O Ipepper não veio para substituir o iFood. Ele é o acréscimo que
              transforma o WhatsApp que você já usa em um canal de vendas
              direto, sem comissão e com a sua marca na frente.
            </p>

            <ul className="mt-8 space-y-5">
              {BENEFITS.map((benefit) => (
                <li key={benefit.title} className="flex gap-3.5">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400 ring-1 ring-inset ring-emerald-400/20">
                    <Icon name="check" className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      {benefit.title}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-400">
                      {benefit.description}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

            <Link
              href="#recursos"
              className="group mt-8 inline-flex items-center gap-2 text-sm font-bold text-amber-300 transition hover:text-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
            >
              Conhecer todos os recursos
              <Icon
                name="arrowRight"
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              />
            </Link>
          </div>

          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute -inset-4 rounded-[2rem] bg-gradient-to-tr from-amber-500/10 via-transparent to-orange-500/10 blur-xl"
            />
            <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0b1017] p-5 shadow-2xl shadow-black/40 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-300">
                    Comparativo rápido
                  </p>
                  <h3 className="mt-1 text-lg font-bold tracking-tight text-white">
                    Seu delivery, lado a lado
                  </h3>
                </div>
                <BrandMark className="h-9 w-9 rounded-xl" />
              </div>

              <table className="mt-6 w-full table-fixed border-collapse text-left">
                <caption className="sr-only">
                  Comparativo entre depender apenas de um marketplace e vender
                  diretamente com o Ipepper
                </caption>
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="w-[34%] pb-3 text-[10px] font-bold uppercase tracking-wide text-gray-500"
                    >
                      Na prática
                    </th>
                    <th
                      scope="col"
                      className="w-[33%] pb-3 pl-2 text-[10px] font-bold uppercase tracking-wide text-gray-500"
                    >
                      Só app
                    </th>
                    <th
                      scope="col"
                      className="w-[33%] pb-3 pl-2 text-[10px] font-bold uppercase tracking-wide text-emerald-300"
                    >
                      Ipepper
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON_ROWS.map((row) => (
                    <tr
                      key={row.label}
                      className="border-t border-white/[0.07]"
                    >
                      <th
                        scope="row"
                        className="py-3 pr-2 text-xs font-medium leading-snug text-gray-300"
                      >
                        {row.label}
                      </th>
                      <td className="py-3 pl-2 align-top">
                        <span className="inline-flex items-start gap-1 text-xs leading-snug text-rose-300/80">
                          <Icon
                            name="x"
                            className="mt-0.5 h-3 w-3 shrink-0"
                          />
                          {row.before}
                        </span>
                      </td>
                      <td className="py-3 pl-2 align-top">
                        <span className="inline-flex items-start gap-1 text-xs font-semibold leading-snug text-emerald-300">
                          <Icon
                            name="check"
                            className="mt-0.5 h-3 w-3 shrink-0"
                          />
                          {row.after}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-5 flex gap-2.5 rounded-xl bg-amber-400/[0.06] p-3 ring-1 ring-inset ring-amber-400/15">
                <Icon
                  name="shield"
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                />
                <p className="text-[11px] leading-relaxed text-gray-400">
                  O Ipepper não substitui seus apps: ele soma um canal direto,
                  sem comissão, para os clientes que já chegam pelo WhatsApp.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

