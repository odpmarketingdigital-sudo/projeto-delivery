import Image from "next/image";
import Link from "next/link";

/**
 * Tela pública de estabelecimento indisponível.
 *
 * Renderizada por `/[slug]` quando a loja existe mas está fora do ar
 * (`status = 'inativo'` ou `subscription_status = 'canceled'`) — ver
 * `lib/storeAvailability.ts`. Também serve de fallback no checkout.
 *
 * Sem estado/hooks: pode ser usada por Server Components e por Client
 * Components (o checkout por slug é server, mas mantém a compatibilidade).
 *
 * Identidade visual: mesma base clara da vitrine (`bg-gray-50` + `dark`),
 * acento âmbar/laranja do logo e o wordmark oficial em `public/logotipo.svg`.
 */
export function StoreUnavailable({
  storeName,
}: {
  /** Nome da loja, quando o cadastro tem um (nunca exibimos slug/e-mail). */
  storeName?: string | null;
}) {
  const name = storeName?.trim() || null;

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 antialiased dark:bg-gray-950">
      <header className="border-b border-gray-200/80 bg-white/80 backdrop-blur-sm dark:border-gray-800 dark:bg-gray-900/70">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center px-4 sm:px-6 lg:px-8">
          {/* O wordmark é amarelo sobre transparente: precisa do selo escuro
              (mesmo tratamento do topo da vitrine) para ficar legível. */}
          <Link
            href="/"
            aria-label="Ipepper — página inicial"
            className="inline-flex items-center rounded-full bg-gray-900 px-3 py-1.5 transition hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            <Image
              src="/logotipo.svg"
              alt="Ipepper"
              width={323}
              height={150}
              preload
              unoptimized
              className="h-5 w-auto sm:h-6"
            />
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-lg text-center">
          {/* Ícone neutro (loja fechada) no acento âmbar da marca. */}
          <span
            aria-hidden="true"
            className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 text-gray-950 shadow-lg shadow-amber-500/25"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-8 w-8"
              aria-hidden="true"
            >
              <path d="M2.25 21h19.5M4.5 3v18m9-18v18m4.5-13.5V21" />
              <path d="M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75" />
              <path d="M6 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21" />
              <path d="M3 3h12m-.75 4.5H21" />
            </svg>
          </span>

          {name && (
            <p className="mt-6 inline-flex max-w-full items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3.5 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
              <svg
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"
                />
              </svg>
              <span className="truncate">{name}</span>
            </p>
          )}

          <h1 className="mt-3 text-2xl font-black tracking-tight text-gray-900 sm:text-3xl dark:text-white">
            Esta loja não está online
          </h1>

          <p className="mx-auto mt-3 max-w-md text-base leading-relaxed text-gray-600 dark:text-gray-400">
            Este estabelecimento está temporariamente indisponível no momento.
            O cardápio volta ao ar assim que a loja for reativada.
          </p>

          <div className="mt-8 rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">
              É o dono desta loja?
            </p>
            <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
              Entre no painel para conferir a situação da assinatura e colocar
              o seu cardápio de volta no ar.
            </p>
            <Link
              href="/painel/assinatura"
              className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 active:scale-[0.99] sm:w-auto dark:bg-yellow-400 dark:text-gray-950 dark:hover:bg-yellow-300"
            >
              Acessar o painel
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3"
                />
              </svg>
            </Link>
          </div>

          <Link
            href="/"
            className="mt-6 inline-flex items-center justify-center text-sm font-semibold text-gray-500 transition hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:text-gray-400 dark:hover:text-white"
          >
            Conhecer o Ipepper
          </Link>
        </div>
      </main>
    </div>
  );
}
