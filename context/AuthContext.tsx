"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

/** Papéis com acesso ao painel administrativo. */
export type AuthRole = "super_admin" | "admin";

/** Usuário atualmente autenticado (sessão do Supabase + perfil). */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: AuthRole;
  establishment?: string;
  /**
   * Situação da confirmação de e-mail (`auth.users.email_confirmed_at`).
   *
   * - `true`  → e-mail confirmado, acesso ao painel liberado;
   * - `false` → conta pendente (`email_confirmed_at` nulo): o painel deve
   *   mandar o usuário para `/confirmar-email`;
   * - `undefined` → não foi possível apurar (falha de rede em
   *   `/api/auth/confirmation`). Nesse caso o guard não bloqueia pelo cliente e
   *   o middleware, que usa `getUser()` no servidor, é quem decide.
   */
  emailConfirmed?: boolean;
}

interface AuthContextValue {
  currentUser: AuthUser | null;
  isAuthenticated: boolean;
  /** True enquanto a sessão/perfil ainda está sendo carregado. */
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Normaliza o papel vindo do banco para os valores aceitos pelo painel. */
function normalizeRole(role: unknown): AuthRole | null {
  if (role === "super_admin" || role === "admin") return role;
  return null;
}

/** Lê um metadado textual do `user_metadata`, se existir. */
function metaString(user: User, key: string): string | undefined {
  const value = user.user_metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Situação da confirmação de e-mail do usuário.
 *
 * `getUser()` e o login devolvem o objeto completo do GoTrue
 * (`email_confirmed_at` nulo quando a conta está pendente). Já os eventos de
 * `onAuthStateChange` são montados a partir do JWT, que não carrega essa data —
 * nesse caso devolvemos `undefined` (desconhecido) em vez de `false`, para não
 * bloquear usuários já confirmados.
 */
function resolveEmailConfirmation(user: User): boolean | undefined {
  const confirmedAt = user.email_confirmed_at ?? user.confirmed_at;
  if (typeof confirmedAt === "string" && confirmedAt.length > 0) return true;
  // Campo presente e vazio/nulo = o servidor informou que não há confirmação.
  if ("email_confirmed_at" in user || "confirmed_at" in user) return false;
  return undefined;
}

/**
 * Pergunta ao servidor se o e-mail da sessão já foi confirmado.
 *
 * O GoTrue omite `email_confirmed_at` quando a conta está pendente, então no
 * cliente o campo fica indistinguível de "não informado". `/api/auth/confirmation`
 * responde com o usuário completo e é usado apenas nesse caso (contas
 * pendentes), mantendo o custo de uma requisição extra desprezível.
 */
async function fetchEmailConfirmation(): Promise<boolean | undefined> {
  try {
    const response = await fetch("/api/auth/confirmation", {
      cache: "no-store",
      credentials: "same-origin",
    });

    if (!response.ok) return undefined;

    const payload = (await response.json()) as { email_confirmed?: boolean };
    return typeof payload.email_confirmed === "boolean"
      ? payload.email_confirmed
      : undefined;
  } catch {
    // Falha de rede: mantém "desconhecido" (o middleware continua barrando).
    return undefined;
  }
}

/**
 * `true` quando os dois usuários têm exatamente os mesmos dados.
 *
 * Usado para preservar a referência do estado: o Supabase emite eventos de auth
 * com frequência (refresh de token, foco da aba, `INITIAL_SESSION`) e recriar o
 * objeto a cada evento re-renderiza todo o painel e refaz as leituras que
 * dependem de `currentUser` (assinatura, estabelecimentos) — causando cascatas
 * de requisições e piscadas de "Carregando...".
 */
function sameAuthUser(a: AuthUser | null, b: AuthUser): boolean {
  return (
    a !== null &&
    a.id === b.id &&
    a.name === b.name &&
    a.email === b.email &&
    a.role === b.role &&
    a.establishment === b.establishment &&
    a.emailConfirmed === b.emailConfirmed
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Evita múltiplos signOut em sequência (laço de redirecionamento).
  const didForceSignOutRef = useRef(false);

  useEffect(() => {
    let active = true;

    /**
     * Resolve o perfil do usuário logado.
     *
     * Estratégia resiliente (evita travar/loopar quando a linha em `profiles`
     * ainda não existe — ex.: trigger não executado):
     *  1. Consulta `profiles` com `.maybeSingle()` — 0 linhas retornam `null`
     *     em vez de lançar erro (diferente de `.single()`).
     *  2. Se não houver linha, faz fallback para os metadados do Auth
     *     (`user_metadata`: name, establishment, role) definidos na criação.
     *  3. Se nem o banco nem os metadados tiverem um papel válido, encerra a
     *     sessão UMA vez para limpar o estado e não criar laço de redirect
     *     entre /painel e /login (o middleware bounces com sessão ativa).
     */
    async function loadProfile(user: User) {
      const { data } = await supabase
        .from("profiles")
        .select("id, name, email, role, establishment")
        .eq("id", user.id)
        .maybeSingle();

      if (!active) return;

      // Papel do banco tem prioridade; senão, usamos o metadado do Auth.
      const dbRole = normalizeRole(data?.role);
      const metaRole = normalizeRole(metaString(user, "role"));
      const role = dbRole ?? metaRole;

      if (!role) {
        // Sessão válida, mas sem perfil/papel de painel conhecido.
        if (!didForceSignOutRef.current) {
          didForceSignOutRef.current = true;
          await supabase.auth.signOut();
        }
        if (!active) return;
        setCurrentUser(null);
        setIsLoading(false);
        return;
      }

      // Eventos de auth (montados do JWT) não trazem `email_confirmed_at`:
      // confirma no servidor quando o dado local é desconhecido.
      let emailConfirmed = resolveEmailConfirmation(user);
      if (emailConfirmed === undefined) {
        emailConfirmed = await fetchEmailConfirmation();
        if (!active) return;
      }

      const nextUser: AuthUser = {
        id: data?.id ?? user.id,
        name: data?.name ?? metaString(user, "name") ?? "",
        email: data?.email ?? user.email ?? "",
        role,
        establishment:
          data?.establishment ?? metaString(user, "establishment") ?? undefined,
        emailConfirmed,
      };
      // Preserva a referência quando o perfil não mudou (ver `sameAuthUser`).
      setCurrentUser((prev) => {
        // Eventos de auth (montados do JWT) não trazem `email_confirmed_at`:
        // mantém o que já foi apurado por `getUser()`/login para esse usuário.
        const merged: AuthUser =
          nextUser.emailConfirmed === undefined &&
          prev?.id === nextUser.id &&
          prev.emailConfirmed !== undefined
            ? { ...nextUser, emailConfirmed: prev.emailConfirmed }
            : nextUser;

        return sameAuthUser(prev, merged) ? prev : merged;
      });
      setIsLoading(false);
    }

    /** Estado inicial: verifica se já existe sessão ativa. */
    supabase.auth.getUser().then(({ data, error }) => {
      if (!active) return;
      if (error || !data.user) {
        setCurrentUser(null);
        setIsLoading(false);
        return;
      }
      loadProfile(data.user);
    });

    // Observa mudanças de autenticação (login, logout, refresh de token).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      if (session?.user) {
        loadProfile(session.user);
      } else {
        setCurrentUser(null);
        setIsLoading(false);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const signOut = useCallback(async () => {
    didForceSignOutRef.current = false;
    await supabase.auth.signOut();
    setCurrentUser(null);
  }, [supabase]);

  const value = useMemo<AuthContextValue>(
    () => ({
      currentUser,
      isAuthenticated: currentUser !== null,
      isLoading,
      signOut,
    }),
    [currentUser, isLoading, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth deve ser usado dentro de um <AuthProvider>.");
  }
  return context;
}

