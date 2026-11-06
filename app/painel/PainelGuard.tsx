"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth, type AuthUser } from "@/context/AuthContext";
import { LogoutButton } from "@/app/components/LogoutButton";
import { isPaywallBypassRoute } from "@/lib/subscriptions";
import {
  SubscriptionProvider,
  useSubscription,
} from "./components/SubscriptionProvider";
import { PanelShell } from "./components/PanelShell";
import { OverdueBanner } from "./components/OverdueBanner";
import { TrialBanner } from "./components/TrialBanner";

/**
 * Guard de rotas do painel (Client Component).
 *
 * Envolve o conteúdo das subrotas de /painel. É este wrapper — e não o layout
 * — que decide, no cliente, se:
 *  - ainda está carregando a sessão/perfil (isLoading);
 *  - o usuário não está autenticado → redireciona para /login;
 *  - o e-mail ainda não foi confirmado (`email_confirmed_at` nulo) → leva para
 *    `/confirmar-email` (o middleware repete a checagem no servidor);
 *  - a rota /painel/admin exige super_admin (senão, volta para /painel);
 *  - o super admin não opera loja: acessar a raiz `/painel` leva direto para
 *    a Dashboard SaaS (`/painel/admin`) — mesmo destino do pós-login;
 *  - a assinatura da loja está válida (trial em dia ou plano ativo). Se não
 *    estiver, apenas `/painel/assinatura` e `/painel/configuracoes` continuam
 *    acessíveis; as demais rotas redirecionam para `/painel/assinatura`.
 *
 * A situação da assinatura é carregada uma única vez pelo
 * <SubscriptionProvider>, que também alimenta o <TrialBanner> e a tela de
 * assinatura. O paywall é *fail-open* (erro de leitura/migração pendente não
 * bloqueia) e ignora super admin, que não é dono de loja.
 *
 * Manter o guard aqui (em vez de direto no layout) preserva o segmento na
 * árvore de renderização — padrão recomendado para Instant Navigation — e
 * evita laços infinitos de redirecionamento.
 */
export function PainelGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { currentUser, isAuthenticated, isLoading } = useAuth();

  const isAdminRoute = pathname?.startsWith("/painel/admin") ?? false;
  // Raiz do painel = visão operacional de loja (Pedidos). O super admin não
  // opera loja, então essa rota é desviada para a Dashboard SaaS.
  const isStoreRoot = pathname === "/painel";
  // Conta criada, mas com o e-mail ainda pendente de confirmação.
  const isEmailUnconfirmed = currentUser?.emailConfirmed === false;

  // Redireciona no máximo uma vez por montagem (evita laços infinitos).
  const hasRedirectedRef = useRef(false);

  // O guard não remonta ao navegar dentro de /painel: guardamos a rota já
  // desviada para não repetir o `replace` a cada re-render, permitindo um
  // novo desvio numa visita posterior.
  const lastStoreRootPathRef = useRef<string | null>(null);

  useEffect(() => {
    // Só toma qualquer decisão depois que o carregamento da sessão/perfil
    // (isLoading) terminou — nunca redireciona durante o estado de loading.
    if (isLoading) return;

    /**
     * NUNCA redirecionar para `/login` daqui.
     *
     * O `proxy` (middleware) já protege todas as rotas `/painel*` no servidor e,
     * quando existe cookie de sessão, devolve `/login` → `/painel`. Se o cliente
     * não conseguir montar o perfil (ex.: `profiles` sem papel, falha de rede no
     * `getUser`) e disparasse `router.replace("/login")`, o navegador entraria no
     * ciclo `/painel` → (`/login` 307) → `/painel` …: cada volta recarrega o
     * documento inteiro e a tela fica piscando "Carregando..." indefinidamente.
     *
     * Por isso o estado "sessão não identificada" é tratado apenas na
     * renderização abaixo, com saída manual (o middleware decide o acesso).
     */
    if (!isAuthenticated) return;

    // E-mail pendente de confirmação: o painel não abre até o clique no link
    // enviado pelo Supabase. O middleware já barra no servidor; esta checagem
    // cobre a navegação client-side (sem novo request ao servidor).
    if (isEmailUnconfirmed) {
      if (hasRedirectedRef.current) return;
      hasRedirectedRef.current = true;
      router.replace("/confirmar-email");
      return;
    }

    // Proteção de role: apenas super_admin acessa /painel/admin.
    // Nunca navegar para a rota atual: no App Router isso ainda dispara uma
    // nova requisição (recarregando a página) e realimenta o efeito.
    if (isAdminRoute && currentUser?.role !== "super_admin") {
      if (hasRedirectedRef.current || pathname === "/painel") return;
      hasRedirectedRef.current = true;
      router.replace("/painel");
      return;
    }

    // Redirecionamento padrão do super admin: a raiz /painel é a visão de
    // loja, então ele vai direto para a Dashboard SaaS.
    if (isStoreRoot && currentUser?.role === "super_admin") {
      if (lastStoreRootPathRef.current === pathname) return;
      lastStoreRootPathRef.current = pathname;
      // `isStoreRoot` garante `pathname === "/painel"` (rota diferente do destino).
      router.replace("/painel/admin");
      return;
    }

    // Fora da raiz: libera um novo desvio numa próxima visita a /painel.
    if (!isStoreRoot) lastStoreRootPathRef.current = null;
  }, [
    isLoading,
    isAuthenticated,
    isAdminRoute,
    isStoreRoot,
    isEmailUnconfirmed,
    pathname,
    currentUser,
    router,
  ]);

  // 1) Carregando a sessão/perfil: ainda não sabemos quem é o usuário.
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm font-medium text-slate-500">Carregando...</p>
      </div>
    );
  }

  // 2) Sessão não identificada no cliente.
  //
  // O acesso já foi autorizado pelo middleware (que redireciona para /login
  // quando não há sessão), mas o perfil pode não ter carregado (RLS, `profiles`
  // sem papel, falha de rede). Aqui NÃO redirecionamos automaticamente: sair
  // da rota dispararia o ciclo /login ⇄ /painel descrito no efeito acima.
  if (!isAuthenticated || !currentUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl text-amber-600">
            🔒
          </span>
          <h1 className="mt-4 text-lg font-bold text-slate-900">
            Sessão não identificada
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Não foi possível confirmar sua sessão neste navegador. Encerre a
            sessão e entre novamente para continuar.
          </p>
          <div className="mt-5 flex items-center justify-center">
            <LogoutButton />
          </div>
          <Link
            href="/login"
            className="mt-3 inline-block text-xs font-semibold text-slate-600 underline-offset-2 hover:text-slate-800 hover:underline"
          >
            Ir para a tela de login
          </Link>
        </div>
      </div>
    );
  }

  // 2.1) Conta com e-mail pendente de confirmação: bloqueia o conteúdo até o
  //      efeito acima levar para `/confirmar-email`.
  if (currentUser.emailConfirmed === false) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl text-amber-600">
            ✉️
          </span>
          <h1 className="mt-4 text-lg font-bold text-slate-900">
            Confirme o seu e-mail
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Por favor, confirme o seu e-mail antes de acessar o painel.
            Redirecionando para a tela de confirmação...
          </p>
          <Link
            href="/confirmar-email"
            className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-yellow-300"
          >
            Reenviar e-mail de confirmação
          </Link>
        </div>
      </div>
    );
  }

  // 3) Rota de admin sem permissão: bloqueia render até o redirecionamento.
  if (isAdminRoute && currentUser.role !== "super_admin") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600">
            ⛔
          </span>
          <h1 className="mt-4 text-lg font-bold text-slate-900">Acesso restrito</h1>
          <p className="mt-2 text-sm text-slate-600">
            Esta área é exclusiva para Super Administradores.
          </p>
          <Link
            href="/painel"
            className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-yellow-300"
          >
            Voltar para o painel
          </Link>
        </div>
      </div>
    );
  }

  // 3.1) Super admin na raiz do painel: tela neutra enquanto o efeito acima
  //      leva para a Dashboard SaaS (evita piscar a visão de loja).
  if (isStoreRoot && currentUser.role === "super_admin") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm font-medium text-slate-500">
          Abrindo a Dashboard SaaS...
        </p>
      </div>
    );
  }

  // 4) Autorizado: a sidebar e o paywall vivem em <PanelFrame>, que também
  //    precisa da situação da assinatura (por isso o provider aqui, depois
  //    das verificações de sessão/role).
  return (
    <SubscriptionProvider>
      <PanelFrame currentUser={currentUser}>{children}</PanelFrame>
    </SubscriptionProvider>
  );
}

/**
 * Casca autenticada do painel: sidebar de navegação, banner de trial e a
 * trava de assinatura sobre o conteúdo da rota.
 *
 * Fluxo:
 *  1. enquanto a assinatura é lida → tela de "Verificando assinatura";
 *  2. assinatura inválida em rota protegida → aviso + `router.replace`
 *     para `/painel/assinatura` (uma vez por rota, sem laço);
 *  3. caso contrário → banner (quando aplicável) + página.
 */
function PanelFrame({
  currentUser,
  children,
}: {
  currentUser: AuthUser;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { isActive, isLoading, isSchemaPending, error, isSuperAdmin, isOverdue } =
    useSubscription();

  const isBypassRoute = isPaywallBypassRoute(pathname);
  // Só bloqueia com informação confiável: erro de leitura ou migração
  // pendente liberam o acesso (fail-open).
  const isBlocked =
    !isSuperAdmin && !isLoading && !isSchemaPending && !error && !isActive;
  const isRedirecting = isBlocked && !isBypassRoute;

  // Redireciona uma única vez por rota bloqueada (evita laço de navegação).
  const lastBlockedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isRedirecting) {
      lastBlockedPathRef.current = null;
      return;
    }
    if (lastBlockedPathRef.current === pathname) return;
    lastBlockedPathRef.current = pathname;
    router.replace("/painel/assinatura");
  }, [isRedirecting, pathname, router]);

  return (
    <PanelShell currentUser={currentUser} isSuperAdmin={isSuperAdmin}>
      <OverdueBanner />
      {isLoading ? (
        <PanelStatusScreen
          title="Verificando assinatura..."
          description="Aguarde enquanto conferimos a situação da sua loja."
        />
      ) : isRedirecting ? (
        <PaywallNotice />
      ) : (
        <>
          {/* Com atraso acima da carência o aviso vermelho já cobre o tema;
              evita duas faixas concorrentes no topo do painel. */}
          {!isOverdue && <TrialBanner />}
          {children}
        </>
      )}
    </PanelShell>
  );
}

/** Tela neutra de espera (mesmo peso visual do loading do guard). */
function PanelStatusScreen({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="text-center">
        <p className="text-sm font-medium text-slate-600">{title}</p>
        {description && (
          <p className="mt-1 text-xs text-slate-500">{description}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Aviso exibido entre o bloqueio e o redirecionamento (conexões lentas ou
 * `router.replace` pendente). Também serve como fallback quando a navegação
 * não acontece.
 */
function PaywallNotice() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-6 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl text-amber-600">
          ⏳
        </span>
        <h1 className="mt-4 text-lg font-bold text-slate-900">
          Seu período de testes expirou
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Para voltar a acessar pedidos, produtos, clientes e dashboard, ative
          o Plano Profissional. Redirecionando para a tela de assinatura...
        </p>
        <Link
          href="/painel/assinatura"
          className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-yellow-300"
        >
          Ir para a assinatura
        </Link>
      </div>
    </div>
  );
}

