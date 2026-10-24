import Image from "next/image";
import Link from "next/link";

/**
 * Logotipo clicável do Ipepper.
 *
 * Usa o arquivo oficial `public/logotipo.svg` (pimenta + wordmark). A altura é
 * fixa e a largura acompanha a proporção original (323×150), então o logo
 * mantém o alinhamento em mobile e desktop.
 *
 * `unoptimized` porque o otimizador de imagens do Next não processa SVG por
 * padrão (`images.dangerouslyAllowSVG` desligado). O arquivo continua sendo
 * servido de forma estática, com `width`/`height` explícitos para evitar
 * layout shift.
 *
 * `compact` é usado em espaços menores (ex.: topo do painel fictício no hero).
 */
export function LandingBrand({
  className = "",
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <Link
      href="/"
      aria-label="Ipepper — página inicial"
      className={`inline-flex items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 ${className}`}
    >
      <Image
        src="/logotipo.svg"
        alt="Ipepper"
        width={323}
        height={150}
        preload
        unoptimized
        className={`w-auto ${compact ? "h-7" : "h-9 sm:h-10"}`}
      />
    </Link>
  );
}
