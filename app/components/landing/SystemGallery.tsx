"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Icon } from "./LandingIcons";

interface Screenshot {
  src: string;
  width: number;
  height: number;
  tag: string;
  title: string;
  description: string;
  alt: string;
}

/**
 * Ordem e dimensões reais dos arquivos em `public/` — os `width`/`height`
 * batem com o original para o Next calcular a proporção sem layout shift.
 */
const SCREENSHOTS: Screenshot[] = [
  {
    src: "/sistema01.webp",
    width: 1365,
    height: 1115,
    tag: "Pedidos",
    title: "Pedidos em tempo real",
    description:
      "Kanban com status, previsão de entrega e um clique para avançar cada pedido.",
    alt: "Tela de pedidos do painel Ipepper com as colunas Pendentes, Em preparo, Saiu para entrega, Concluídos e Cancelados",
  },
  {
    src: "/sistema02.webp",
    width: 1365,
    height: 1329,
    tag: "Dashboard",
    title: "Dashboard de vendas",
    description:
      "Faturamento, ticket médio e os dias de maior e menor venda em um só lugar.",
    alt: "Dashboard de vendas do Ipepper com faturamento, pedidos, ticket médio e gráfico de evolução por hora",
  },
  {
    src: "/sistema03.webp",
    width: 1365,
    height: 653,
    tag: "Cupons",
    title: "Cupons de desconto",
    description:
      "Crie códigos percentuais ou de valor fixo, com limite de uso e acompanhamento.",
    alt: "Tela de cupons de desconto do Ipepper com cupom ativo, total de cupons e usos acumulados",
  },
  {
    src: "/sistema04.webp",
    width: 1365,
    height: 1151,
    tag: "Cardápio",
    title: "Cardápio do estabelecimento",
    description:
      "Categorias, produtos, adicionais e estoque organizados para publicar em minutos.",
    alt: "Tela do cardápio do Ipepper com categorias, lista de produtos, preços, status e adicionais",
  },
];

/**
 * Galeria "Conheça o Sistema por Dentro".
 *
 * Client Component apenas por causa do lightbox (ampliar o print). O grid em
 * si é estático e usa `next/image` com proporção original, então nenhuma
 * imagem é cortada. Fecha com Esc, clique no fundo ou botão de fechar.
 */
export function SystemGallery() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex === null ? null : SCREENSHOTS[openIndex];

  useEffect(() => {
    if (openIndex === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenIndex(null);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openIndex]);

  return (
    <section
      id="sistema"
      className="relative scroll-mt-24 overflow-hidden border-y border-white/[0.06] bg-[#080b10] py-20 sm:py-24"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-32 top-24 h-80 w-80 rounded-full bg-amber-500/[0.07] blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-32 bottom-10 h-80 w-80 rounded-full bg-orange-500/[0.06] blur-3xl"
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-amber-300">
              <span className="h-px w-6 bg-amber-400/60" />
              Conheça o Sistema por Dentro
            </span>
            <h2 className="mt-4 text-balance text-3xl font-black tracking-[-0.03em] text-white sm:text-4xl">
              Telas reais do painel que você vai usar todos os dias
            </h2>
            <p className="mt-4 text-pretty text-base leading-relaxed text-gray-400">
              Pedidos, dashboard, cupons e cardápio: nada de mockup. Clique em
              qualquer imagem para ampliar e ver os detalhes.
            </p>
          </div>
          <Link
            href="/demo"
            className="group inline-flex w-fit shrink-0 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-5 py-3 text-sm font-bold text-white transition hover:border-white/25 hover:bg-white/[0.07] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            <Icon name="play" className="h-4 w-4 text-amber-300" />
            Abrir demonstração ao vivo
          </Link>
        </div>

        <div className="mt-12 grid items-start gap-5 sm:grid-cols-2">
          {SCREENSHOTS.map((shot, index) => (
            <figure
              key={shot.src}
              className="group overflow-hidden rounded-3xl border border-white/10 bg-[#0b1017] p-2.5 shadow-2xl shadow-black/40 transition duration-300 hover:border-amber-400/30"
            >
              <button
                type="button"
                onClick={() => setOpenIndex(index)}
                aria-label={`Ampliar imagem: ${shot.title}`}
                className="relative block w-full overflow-hidden rounded-2xl border border-white/[0.06] bg-gray-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
              >
                <Image
                  src={shot.src}
                  alt={shot.alt}
                  width={shot.width}
                  height={shot.height}
                  sizes="(max-width: 640px) 92vw, (max-width: 1024px) 46vw, 560px"
                  className="h-auto w-full transition duration-500 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                />
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-gray-950/40 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
                <span className="pointer-events-none absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-gray-950/85 px-3 py-1.5 text-[11px] font-bold text-white opacity-0 shadow-lg backdrop-blur transition group-hover:opacity-100">
                  <Icon name="sparkles" className="h-3.5 w-3.5 text-amber-300" />
                  Ampliar
                </span>
              </button>

              <figcaption className="px-2 pb-1 pt-4">
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-300">
                  {shot.tag}
                </span>
                <h3 className="mt-2.5 text-base font-bold tracking-tight text-white">
                  {shot.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-400">
                  {shot.description}
                </p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Imagem ampliada: ${open.title}`}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpenIndex(null);
          }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-gray-950/90 p-4 backdrop-blur-sm sm:p-8"
        >
          <div className="relative w-full max-w-6xl">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-white">{open.title}</p>
                <p className="text-xs text-gray-400">{open.description}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpenIndex(null)}
                aria-label="Fechar imagem ampliada"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/[0.05] text-gray-200 transition hover:bg-white/[0.1] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              >
                <Icon name="close" className="h-5 w-5" />
              </button>
            </div>
            <Image
              src={open.src}
              alt={open.alt}
              width={open.width}
              height={open.height}
              sizes="(max-width: 1024px) 96vw, 1100px"
              className="h-auto max-h-[80vh] w-full rounded-2xl border border-white/10 object-contain shadow-2xl shadow-black/60"
            />
          </div>
        </div>
      )}
    </section>
  );
}
