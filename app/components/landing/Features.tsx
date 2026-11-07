import { Icon, type IconName } from "./LandingIcons";

interface Feature {
  icon: IconName;
  title: string;
  description: string;
  tags: string[];
}

const FEATURES: Feature[] = [
  {
    icon: "smartphone",
    title: "Cardápio Digital Inteligente",
    description:
      "Cadastro fácil de produtos, adicionais, categorias e opções com fotos. O estoque é atualizado automaticamente a cada venda.",
    tags: ["Fotos e adicionais", "Categorias", "Estoque automático"],
  },
  {
    icon: "clock",
    title: "Horário de Funcionamento Automatizado",
    description:
      "Defina os horários da semana. Fora do expediente, os pedidos são bloqueados automaticamente e a vitrine avisa o cliente.",
    tags: ["Agenda semanal", "Bloqueio automático", "Aviso na vitrine"],
  },
  {
    icon: "clipboard",
    title: "Gestão de Pedidos em Tempo Real",
    description:
      "Kanban e lista compacta de pedidos com status, notificação sonora, impressão térmica (58 mm / 80 mm) e motivo de cancelamento.",
    tags: ["Kanban", "Impressão térmica", "Status ao vivo"],
  },
  {
    icon: "chart",
    title: "Dashboard & Estatísticas de Vendas",
    description:
      "Métricas diárias, mensais e anuais. Identifique o dia de maior venda e o de menor movimento para planejar estoque e promoções.",
    tags: ["Diário e mensal", "Dia mais forte", "Dia mais fraco"],
  },
  {
    icon: "users",
    title: "Gestão e Histórico de Clientes",
    description:
      "Lista unificada de clientes que já compraram, total gasto, ticket médio e botão para chamar no WhatsApp com 1 clique.",
    tags: ["Histórico", "Ticket médio", "Contato rápido"],
  },
  {
    icon: "tag",
    title: "Gerenciador de Cupons de Desconto",
    description:
      "Crie cupons percentuais ou de valor fixo, defina valor mínimo e limite de utilizações para atrair novos clientes.",
    tags: ["% ou valor fixo", "Valor mínimo", "Limite de usos"],
  },
];

/**
 * Seção de recursos: os seis pilares do painel Ipepper.
 */
export function Features() {
  return (
    <section
      id="recursos"
      className="relative scroll-mt-24 py-20 sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-600">
              <span className="h-px w-6 bg-amber-500/60" />
              Recursos do painel
            </span>
            <h2 className="mt-4 text-balance text-3xl font-black tracking-[-0.03em] text-gray-900 sm:text-4xl">
              Tudo o que seu estabelecimento precisa, em um só painel
            </h2>
            <p className="mt-4 text-pretty text-base leading-relaxed text-gray-600">
              Menos trabalho manual, mais pedidos organizados. Cada recurso foi
              pensado para o dia a dia de quem vende comida de verdade.
            </p>
          </div>
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-600 shadow-sm">
            <Icon name="sparkles" className="h-4 w-4 text-amber-500" />
            Tudo incluso no mesmo acesso
          </span>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <article
              key={feature.title}
              className="group relative overflow-hidden rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition duration-300 hover:-translate-y-1 hover:border-amber-400/50 hover:shadow-lg hover:shadow-amber-500/5"
            >
              <div
                aria-hidden="true"
                className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-amber-400/20 opacity-0 blur-2xl transition duration-300 group-hover:opacity-100"
              />

              <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500/15 to-orange-500/10 text-amber-600 ring-1 ring-inset ring-amber-500/20">
                <Icon name={feature.icon} className="h-5 w-5" />
              </div>

              <h3 className="relative mt-5 text-base font-bold tracking-tight text-gray-900">
                {feature.title}
              </h3>
              <p className="relative mt-2 text-sm leading-relaxed text-gray-600">
                {feature.description}
              </p>

              <ul className="relative mt-5 flex flex-wrap gap-1.5">
                {feature.tags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-[10px] font-medium text-gray-500"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
