import Image from "next/image";
import Link from "next/link";
import { Icon } from "./LandingIcons";

/**
 * Seção Hero: proposta de valor, CTAs e a imagem real do sistema.
 *
 * A coluna direita exibe o screenshot oficial `public/sistema-ipepper-delivery2.webp`
 * (painel de pedidos no desktop + vitrine no celular) com `next/image` e
 * `preload`, já que essa imagem é o principal elemento visual do hero.
 */
export function LandingHero() {
  return (
    <section
      id="inicio"
      className="relative isolate scroll-mt-24 overflow-hidden pt-14 sm:pt-6 lg:pt-8"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute left-1/2 top-[-22rem] h-[38rem] w-[62rem] -translate-x-1/2 rounded-full bg-amber-400/[0.16] blur-3xl" />
        <div className="absolute bottom-0 left-0 right-0 h-40 bg-gradient-to-t from-[#FAFAFA] to-transparent" />
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8 lg:pb-28">
        <div className="grid items-center gap-16 lg:grid-cols-[0.9fr_1.1fr] lg:gap-10">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-amber-700">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              Seu canal próprio no WhatsApp
            </span>

            <h1 className="mt-6 text-balance text-4xl font-black leading-[1.05] tracking-[-0.04em] text-gray-900 sm:text-5xl lg:text-[3.6rem]">
              O Cardápio Digital que Transforma seu WhatsApp em uma{" "}
              <span className="bg-gradient-to-r from-amber-600 via-orange-500 to-orange-600 bg-clip-text text-transparent">
                Máquina de Vendas!
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-pretty text-base leading-relaxed text-gray-600 sm:text-lg">
              Não substitua os aplicativos tradicionais, some forças! Mande o
              link do seu cardápio no atendimento automático do WhatsApp e
              receba pedidos organizados no seu balcão.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/cadastro"
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-6 py-3.5 text-sm font-black text-gray-900 shadow-xl shadow-amber-500/25 transition hover:bg-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                Cadastre-se grátis
                <Icon
                  name="arrowRight"
                  className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                />
              </Link>
              <Link
                href="/burger-gourmet"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-6 py-3.5 text-sm font-bold text-gray-800 transition hover:border-gray-400 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <Icon name="play" className="h-4 w-4 text-amber-600" />
                Ver Demonstração ao Vivo
              </Link>
            </div>

            <ul className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs font-medium text-gray-600">
              {[
                "0% de comissão por pedido",
                "Pedido direto no painel",
                "Sua base de clientes",
              ].map((item) => (
                <li key={item} className="inline-flex items-center gap-1.5">
                  <Icon
                    name="check"
                    className="h-3.5 w-3.5 text-emerald-600"
                  />
                  {item}
                </li>

              ))}
            </ul>

            <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t border-gray-200 pt-6">
              <div className="flex flex-col-reverse">
                <dt className="mt-1 text-[11px] leading-tight text-gray-500">
                  de comissão por pedido
                </dt>
                <dd className="text-2xl font-black tracking-tight text-gray-900">
                  0%
                </dd>
              </div>
              <div className="flex flex-col-reverse">
                <dt className="mt-1 text-[11px] leading-tight text-gray-500">
                  link para vender
                </dt>
                <dd className="text-2xl font-black tracking-tight text-gray-900">
                  1
                </dd>
              </div>
              <div className="flex flex-col-reverse">
                <dt className="mt-1 text-[11px] leading-tight text-gray-500">
                  da sua base de clientes
                </dt>
                <dd className="text-2xl font-black tracking-tight text-gray-900">
                  100%
                </dd>
              </div>
            </dl>
          </div>

          <div className="relative mx-auto w-full max-w-[660px] lg:max-w-none">
            <Image
              src="/sistema-ipepper-delivery2.webp"
              alt="Painel do Sistema Ipepper: pedidos em tempo real no computador e cardápio digital no celular do cliente"
              width={1920}
              height={1080}
              preload
              sizes="(max-width: 640px) 96vw, (max-width: 1024px) 94vw, 800px"
              className="h-auto w-full drop-shadow-2xl"
            />
          </div>
        </div>
      </div>
    </section>
  );
}


