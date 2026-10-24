import Link from "next/link";
import { BrandMark, Icon } from "./LandingIcons";

/**
 * Banner final de conversão, antes do rodapé.
 */
export function FinalCta() {
  return (
    <section className="relative pb-20 pt-4 sm:pb-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 px-6 py-12 text-gray-950 shadow-2xl shadow-amber-500/20 sm:px-10 sm:py-16 lg:px-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full border-[32px] border-white/10"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-white/10 blur-2xl"
          />
          <div
            aria-hidden="true"
            className="absolute -bottom-10 right-8 hidden rotate-6 opacity-20 lg:block"
          >
            <BrandMark className="h-32 w-32 rounded-[2rem]" />
          </div>

          <div className="relative max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full bg-gray-950/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-gray-950 ring-1 ring-inset ring-gray-950/15">
              <Icon name="bolt" className="h-3.5 w-3.5" />
              Comece hoje
            </span>
            <h2 className="mt-5 text-balance text-3xl font-black leading-[1.08] tracking-[-0.04em] sm:text-4xl lg:text-5xl">
              Transforme cada conversa do WhatsApp em um pedido organizado.
            </h2>
            <p className="mt-4 max-w-2xl text-pretty text-sm font-medium leading-relaxed text-gray-900/80 sm:text-base">
              Cadastre seu cardápio, personalize com a sua marca e comece a
              receber pedidos direto no painel — sem comissão por venda e sem
              depender de atendimento manual.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/cadastro"
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-gray-950 px-6 py-3.5 text-sm font-black text-white shadow-xl shadow-gray-950/20 transition hover:bg-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 focus-visible:ring-offset-2 focus-visible:ring-offset-amber-400"
              >
                Criar Meu Cardápio
                <Icon
                  name="arrowRight"
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                />
              </Link>
              <Link
                href="/demo"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-950/20 bg-white/20 px-6 py-3.5 text-sm font-bold text-gray-950 transition hover:bg-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 focus-visible:ring-offset-2 focus-visible:ring-offset-amber-400"
              >
                <Icon name="play" className="h-4 w-4" />
                Ver Demonstração
              </Link>
            </div>

            <p className="mt-4 text-xs font-medium text-gray-900/70">
              Já tem uma conta?{" "}
              <Link
                href="/login"
                className="font-bold underline decoration-gray-950/30 underline-offset-2 transition hover:decoration-gray-950"
              >
                Acessar o painel
              </Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
