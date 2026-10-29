"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/context/AuthContext";
import type { Establishment } from "@/lib/types";
import { AdminHeader } from "../components/AdminHeader";

/** Metadados visuais do status do estabelecimento. */
const STATUS_META: Record<
  Establishment["status"],
  { label: string; badge: string; dot: string }
> = {
  ativo: {
    label: "Ativo",
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    dot: "bg-emerald-400",
  },
  inativo: {
    label: "Inativo",
    badge: "bg-gray-600/30 text-gray-400 border-gray-600/50",
    dot: "bg-gray-500",
  },
};

type StatusFilter = "todos" | Establishment["status"];

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "todos", label: "Todos os status" },
  { value: "ativo", label: "Ativo" },
  { value: "inativo", label: "Inativo" },
];

/** Estado do formulário de criação/edição de estabelecimento. */
interface FormState {
  /** Nome da loja (estabelecimento). */
  name: string;
  /** Nome do responsável (dono). */
  owner_name: string;
  /** E-mail de contato (também é o login da conta de acesso). */
  email: string;
  /** Telefone de contato (opcional). */
  phone: string;
  /** Senha — obrigatória na criação; na edição, redefine a senha no Auth. */
  password: string;
  status: Establishment["status"];
}

const EMPTY_FORM: FormState = {
  name: "",
  owner_name: "",
  email: "",
  phone: "",
  password: "",
  status: "ativo",
};

/** Gera uma senha inicial simples e legível para o novo estabelecimento. */
function generatePassword(): string {
  const words = ["fuego", "burger", "delivery", "sabor", "chama"];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}@${num}`;
}

/**
 * Formata um valor de data (ISO do Supabase ou Date) como dd/mm/aaaa.
 * Retorna "—" quando o valor é inválido/ausente.
 */
function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export default function AdminEstabelecimentosPage() {
  const supabase = useMemo(() => createClient(), []);
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  // Lista real de estabelecimentos (tabela public.establishments).
  const [establishments, setEstablishments] = useState<Establishment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Guarda as senhas geradas no cadastro desta sessão (nunca vêm do banco),
  // apenas para o botão "Copiar Acesso". Map: email -> senha.
  const passwordMapRef = useRef<Map<string, string>>(new Map());

  // Modais de criação/edição e de exclusão.
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [editing, setEditing] = useState<Establishment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Establishment | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Filtros de busca e status.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos");

  /** Consulta compartilhada: lista de estabelecimentos ordenada por cadastro. */
  const fetchEstablishments = useCallback(async () => {
    const { data, error } = await supabase
      .from("establishments")
      .select(
        "id, user_id, name, owner_name, email, phone, slug, status, created_at, updated_at"
      )
      .order("created_at", { ascending: false });

    if (error) {
      setEstablishments([]);
      setLoadError(
        "Não foi possível carregar os estabelecimentos. Verifique se a tabela establishments existe e tente novamente."
      );
      return;
    }
    setEstablishments((data as Establishment[]) ?? []);
    setLoadError(null);
  }, [supabase]);

  // Carregamento inicial.
  useEffect(() => {
    let active = true;
    (async () => {
      setIsLoading(true);
      await fetchEstablishments();
      if (active) setIsLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [fetchEstablishments]);

  /** Recarrega a lista (usada dentro de handlers de evento). */
  const refreshEstablishments = useCallback(async () => {
    setIsLoading(true);
    await fetchEstablishments();
    setIsLoading(false);
  }, [fetchEstablishments]);

  /**
   * Cria (POST) ou atualiza (PUT) um estabelecimento.
   * - `id` ausente → cria conta de acesso (Auth) + registro em `establishments`.
   * - `id` presente → atualiza nome, responsável e status.
   * Lança Error em caso de falha (capturado pelo modal para exibir a mensagem).
   */
  const handleSave = useCallback(
    async (form: FormState, id?: string) => {
      let res: Response;

      if (id) {
        res = await fetch("/api/admin/update-establishment", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            name: form.name,
            owner_name: form.owner_name,
            phone: form.phone,
            status: form.status,
            password: form.password || undefined,
          }),
        });
      } else {
        res = await fetch("/api/admin/create-establishment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            owner_name: form.owner_name,
            email: form.email,
            phone: form.phone,
            password: form.password,
            status: form.status,
          }),
        });
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Falha ao salvar o estabelecimento.");
      }

      // Guarda a senha para o botão "Copiar Acesso" (criação ou redefinição).
      if (form.email && form.password) {
        passwordMapRef.current.set(form.email, form.password);
      }

      setActionError(null);
      setIsNewModalOpen(false);
      setEditing(null);
      await refreshEstablishments();
    },
    [refreshEstablishments]
  );

  /** Exclui o estabelecimento (e a conta de acesso vinculada). */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget || isDeleting) return;

    setIsDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/admin/delete-establishment", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Falha ao excluir o estabelecimento.");
      }

      passwordMapRef.current.delete(deleteTarget.email);
      setIsDeleteModalOpen(false);
      setDeleteTarget(null);
      await refreshEstablishments();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Erro inesperado ao excluir."
      );
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, isDeleting, refreshEstablishments]);

  /** Alterna rapidamente o status (Ativo ↔ Inativo) pela própria tabela. */
  const handleToggleStatus = useCallback(
    async (est: Establishment) => {
      const nextStatus: Establishment["status"] =
        est.status === "ativo" ? "inativo" : "ativo";
      try {
        await handleSave(
          {
            name: est.name,
            owner_name: est.owner_name,
            email: est.email,
            phone: est.phone ?? "",
            password: "",
            status: nextStatus,
          },
          est.id
        );
      } catch (err) {
        setActionError(
          err instanceof Error
            ? err.message
            : "Falha ao alterar o status do estabelecimento."
        );
      }
    },
    [handleSave]
  );

  /** Copia "E-mail: ... / Senha: ..." para a área de transferência. */
  const copyAccess = useCallback(async (est: Establishment) => {
    const password = passwordMapRef.current.get(est.email) ?? "";
    const text = password
      ? `E-mail: ${est.email}\nSenha: ${password}`
      : `E-mail: ${est.email}\nSenha: (gerada somente no cadastro)`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback para navegadores sem Clipboard API (ex: contexto não seguro).
    }
  }, []);

  /**
   * Monta o link público do cardápio da loja (para o lojista compartilhar
   * via WhatsApp). Usa a URL amigável por slug (`/[slug]`) quando existir;
   * sem slug, cai no identificador por query (`/?establishment_id=`).
   */
  const buildMenuLink = useCallback((est: Establishment): string => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return est.slug ? `${origin}/${est.slug}` : `${origin}/?establishment_id=${est.id}`;
  }, []);

  /** Copia o link público do cardápio para a área de transferência. */
  const copyMenuLink = useCallback(
    async (est: Establishment) => {
      try {
        await navigator.clipboard.writeText(buildMenuLink(est));
      } catch {
        // Fallback para navegadores sem Clipboard API (ex: contexto não seguro).
      }
    },
    [buildMenuLink]
  );

  const openCreate = () => {
    setActionError(null);
    setEditing(null);
    setIsNewModalOpen(true);
  };

  const openEdit = (est: Establishment) => {
    setActionError(null);
    setEditing(est);
    setIsNewModalOpen(true);
  };

  const openDelete = (est: Establishment) => {
    setDeleteError(null);
    setDeleteTarget(est);
    setIsDeleteModalOpen(true);
  };

  /** Lista filtrada por busca (nome, responsável, e-mail) e status. */
  const filteredEstablishments = useMemo(() => {
    const term = search.trim().toLowerCase();
    return establishments.filter((est) => {
      const matchesStatus =
        statusFilter === "todos" || est.status === statusFilter;
      if (!matchesStatus) return false;
      if (!term) return true;
      return (
        est.name.toLowerCase().includes(term) ||
        est.owner_name.toLowerCase().includes(term) ||
        est.email.toLowerCase().includes(term) ||
        (est.phone ?? "").toLowerCase().includes(term)
      );
    });
  }, [establishments, search, statusFilter]);

  /** Valores iniciais do modal (edição preenche a partir do registro). */
  const modalInitial: FormState = editing
    ? {
        name: editing.name,
        owner_name: editing.owner_name,
        email: editing.email,
        phone: editing.phone ?? "",
        password: "",
        status: editing.status,
      }
    : EMPTY_FORM;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AdminHeader establishmentId={null} isSuperAdmin={isSuperAdmin} />

      <main className="px-4 py-8 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-6xl">
        {/* Cabeçalho */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Gestão de Estabelecimentos
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              Cadastre, edite e controle os estabelecimentos da plataforma.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm font-semibold">
              <Link
                href="/painel/admin/assinantes"
                className="text-yellow-300 transition hover:text-yellow-200"
              >
                Ver assinantes →
              </Link>
              <span aria-hidden="true" className="text-gray-700">
                |
              </span>
              <Link
                href="/painel/admin/configuracoes"
                className="text-gray-400 transition hover:text-white"
              >
                Preço do plano →
              </Link>
              <span aria-hidden="true" className="text-gray-700">
                |
              </span>
              <Link
                href="/painel/admin/cupons"
                className="text-gray-400 transition hover:text-white"
              >
                Cupons de assinatura →
              </Link>
            </div>
          </div>

          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4v16m8-8H4"
              />
            </svg>
            Novo Estabelecimento
          </button>
        </header>

        {/* Controles: busca + filtro de status */}
        <section className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
              />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por estabelecimento, responsável ou e-mail..."
              className="w-full rounded-xl border border-gray-800 bg-gray-900/50 py-2.5 pl-10 pr-3 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60"
            />
          </div>

          <select
            aria-label="Filtrar por status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="rounded-xl border border-gray-800 bg-gray-900/50 px-3 py-2.5 text-sm text-gray-200 outline-none transition focus:border-yellow-400/60 sm:w-48"
          >
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </section>

        {/* Erro de ação rápida (ex: falha ao alternar status) */}
        {actionError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3"
          >
            <p className="text-sm font-medium text-red-400">{actionError}</p>
            <button
              type="button"
              onClick={() => setActionError(null)}
              aria-label="Fechar aviso"
              className="text-red-400 transition hover:text-red-300"
            >
              ✕
            </button>
          </div>
        )}

        {/* Estados: carregando / erro / vazio / lista */}
        {isLoading ? (
          <ul
            className="space-y-3"
            aria-busy="true"
            aria-label="Carregando estabelecimentos"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <li
                key={i}
                className="h-16 animate-pulse rounded-2xl border border-gray-800 bg-gray-900/50"
              />
            ))}
          </ul>
        ) : loadError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 px-6 py-12 text-center"
          >
            <p className="text-sm font-medium text-red-400">{loadError}</p>
            <button
              type="button"
              onClick={() => void refreshEstablishments()}
              className="rounded-xl bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/25"
            >
              Tentar novamente
            </button>
          </div>
        ) : filteredEstablishments.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-gray-800 bg-gray-900/30 px-6 py-12 text-center">
            <svg
              aria-hidden="true"
              className="h-10 w-10 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-sm font-medium text-gray-300">
              {search || statusFilter !== "todos"
                ? "Nenhum estabelecimento encontrado para os filtros aplicados."
                : "Nenhum estabelecimento cadastrado ainda."}
            </p>
            {!search && statusFilter === "todos" && (
              <button
                type="button"
                onClick={openCreate}
                className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-bold text-gray-950 transition hover:bg-yellow-300"
              >
                Cadastrar o primeiro estabelecimento
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Tabela (desktop) */}
            <div className="hidden overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/50 md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-gray-800 bg-gray-900/60 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Estabelecimento</th>
                    <th className="px-5 py-3 font-semibold">Responsável</th>
                    <th className="px-5 py-3 font-semibold">E-mail</th>
                    <th className="px-5 py-3 font-semibold">Telefone</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 font-semibold">Cadastro</th>
                    <th className="px-5 py-3 text-right font-semibold">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEstablishments.map((est) => {
                    const meta = STATUS_META[est.status];
                    return (
                      <tr
                        key={est.id}
                        className="border-b border-gray-800/60 transition last:border-0 hover:bg-gray-800/40"
                      >
                        <td className="px-5 py-3.5">
                          <p className="font-semibold text-gray-100">
                            {est.name}
                          </p>
                        </td>
                        <td className="px-5 py-3.5 text-gray-300">
                          {est.owner_name}
                        </td>
                        <td className="px-5 py-3.5">
                          <span className="text-gray-400">{est.email}</span>
                        </td>
                        <td className="px-5 py-3.5 text-gray-400">
                          {est.phone || "—"}
                        </td>
                        <td className="px-5 py-3.5">
                          <button
                            type="button"
                            onClick={() => void handleToggleStatus(est)}
                            title={`Clique para ${
                              est.status === "ativo" ? "desativar" : "ativar"
                            }`}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-125 ${meta.badge}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${meta.dot}`}
                            />
                            {meta.label}
                          </button>
                        </td>
                        <td className="px-5 py-3.5 text-gray-400">
                          {formatDate(est.created_at)}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center justify-end gap-1">
                            <ActionIcon
                              label="Editar"
                              onClick={() => openEdit(est)}
                            >
                              <svg
                                aria-hidden="true"
                                className="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M11 5h6M12 19h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
                                />
                              </svg>
                            </ActionIcon>
                            <ActionIcon
                              label="Copiar link do cardápio"
                              onClick={() => void copyMenuLink(est)}
                            >
                              <svg
                                aria-hidden="true"
                                className="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
                                />
                              </svg>
                            </ActionIcon>
                            <ActionIcon
                              label="Copiar Acesso"
                              onClick={() => void copyAccess(est)}
                            >
                              <svg
                                aria-hidden="true"
                                className="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2M10 8h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2z"
                                />
                              </svg>
                            </ActionIcon>
                            <ActionIcon
                              label="Excluir"
                              danger
                              onClick={() => openDelete(est)}
                            >
                              <svg
                                aria-hidden="true"
                                className="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            </ActionIcon>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Cards (mobile) */}
            <ul className="space-y-3 md:hidden">
              {filteredEstablishments.map((est) => {
                const meta = STATUS_META[est.status];
                return (
                  <li
                    key={est.id}
                    className="rounded-2xl border border-gray-800 bg-gray-900/50 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-gray-100">
                          {est.name}
                        </p>
                        <p className="mt-0.5 truncate text-sm text-gray-400">
                          {est.owner_name}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-gray-500">
                          {est.email}
                        </p>
                        {est.phone && (
                          <p className="mt-0.5 truncate text-xs text-gray-500">
                            {est.phone}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleToggleStatus(est)}
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover:brightness-125 ${meta.badge}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${meta.dot}`}
                        />
                        {meta.label}
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                      Cadastrado em {formatDate(est.created_at)}
                    </p>
                    <div className="mt-3 flex items-center gap-2 border-t border-gray-800 pt-3">
                      <button
                        type="button"
                        onClick={() => void copyMenuLink(est)}
                        title={buildMenuLink(est)}
                        className="flex-1 rounded-lg border border-gray-700 py-2 text-xs font-semibold text-gray-200 transition hover:bg-gray-800"
                      >
                        Copiar Link
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(est)}
                        className="flex-1 rounded-lg border border-gray-700 py-2 text-xs font-semibold text-gray-200 transition hover:bg-gray-800"
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyAccess(est)}
                        className="flex-1 rounded-lg border border-gray-700 py-2 text-xs font-semibold text-gray-200 transition hover:bg-gray-800"
                      >
                        Copiar Acesso
                      </button>
                      <button
                        type="button"
                        onClick={() => openDelete(est)}
                        className="flex-1 rounded-lg border border-red-500/30 py-2 text-xs font-semibold text-red-400 transition hover:bg-red-500/10"
                      >
                        Excluir
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {/* Modais */}
        {isNewModalOpen && (
          <FormModal
            isEditing={Boolean(editing)}
            initial={modalInitial}
            onClose={() => {
              setIsNewModalOpen(false);
              setEditing(null);
            }}
            onSubmit={(form) => handleSave(form, editing?.id)}
          />
        )}

        {isDeleteModalOpen && deleteTarget && (
          <DeleteConfirmModal
            establishment={deleteTarget}
            isDeleting={isDeleting}
            error={deleteError}
            onCancel={() => {
              setIsDeleteModalOpen(false);
              setDeleteTarget(null);
              setDeleteError(null);
            }}
            onConfirm={() => void handleDelete()}
          />
        )}
        </div>
      </main>
    </div>
  );
}

/**
 * Modal de criação/edição de estabelecimento.
 * Controla o formulário localmente; envia via `onSubmit` e exibe erros inline
 * (o parent fecha o modal em caso de sucesso).
 */
function FormModal({
  isEditing,
  initial,
  onClose,
  onSubmit,
}: {
  isEditing: boolean;
  initial: FormState;
  onClose: () => void;
  onSubmit: (form: FormState) => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fecha com ESC e trava o scroll do body enquanto aberto.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, isSubmitting]);

  const set = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);

    const name = form.name.trim();
    const ownerName = form.owner_name.trim();
    const email = form.email.trim();
    const phone = form.phone.trim();

    if (!name || !ownerName) {
      setError("Preencha o nome da loja e o responsável.");
      return;
    }
    if (!isEditing) {
      if (!email || !form.password) {
        setError("Preencha o e-mail e a senha.");
        return;
      }
    }
    if (form.password && form.password.length < 6) {
      setError("A senha deve ter ao menos 6 caracteres.");
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        ...form,
        name,
        owner_name: ownerName,
        email,
        phone,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    "w-full rounded-xl border border-gray-700 bg-gray-900/60 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none transition focus:border-yellow-400/60";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-gray-800 bg-gray-900 shadow-xl">
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-bold text-white">
            {isEditing ? "Editar estabelecimento" : "Novo estabelecimento"}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {isEditing
              ? "Ajuste a loja, o responsável e o status."
              : "Será criada também a conta de acesso no Supabase Auth."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          <div>
            <label
              htmlFor="est-name"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              Nome da loja
            </label>
            <input
              id="est-name"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Ex: Fuego Burger"
              className={inputClass}
              autoFocus
            />
          </div>

          <div>
            <label
              htmlFor="est-owner"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              Responsável (dono)
            </label>
            <input
              id="est-owner"
              value={form.owner_name}
              onChange={(e) => set({ owner_name: e.target.value })}
              placeholder="Ex: João Silva"
              className={inputClass}
            />
          </div>

          <div>
            <label
              htmlFor="est-email"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              E-mail de contato
            </label>
            <input
              id="est-email"
              type="email"
              value={form.email}
              onChange={(e) => set({ email: e.target.value })}
              placeholder="contato@loja.com"
              readOnly={isEditing}
              className={`${inputClass} ${
                isEditing ? "cursor-not-allowed opacity-60" : ""
              }`}
            />
            {isEditing && (
              <p className="mt-1 text-xs text-gray-500">
                O e-mail de login não é alterado nesta edição.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="est-phone"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              Telefone
            </label>
            <input
              id="est-phone"
              type="tel"
              value={form.phone}
              onChange={(e) => set({ phone: e.target.value })}
              placeholder="Ex: (11) 99999-9999"
              className={inputClass}
            />
          </div>

          <div>
            <label
              htmlFor="est-password"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              {isEditing ? "Nova senha (opcional)" : "Senha de acesso"}
            </label>
            <div className="flex gap-2">
              <input
                id="est-password"
                type="text"
                value={form.password}
                onChange={(e) => set({ password: e.target.value })}
                placeholder={
                  isEditing
                    ? "Deixe em branco para manter a atual"
                    : "Mínimo 6 caracteres"
                }
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => set({ password: generatePassword() })}
                className="shrink-0 rounded-xl border border-gray-700 px-3 text-sm font-semibold text-gray-200 transition hover:bg-gray-800"
              >
                Gerar
              </button>
            </div>
            {isEditing && (
              <p className="mt-1 text-xs text-gray-500">
                Informe apenas se quiser redefinir a senha da conta de acesso.
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="est-status"
              className="mb-1.5 block text-sm font-semibold text-gray-200"
            >
              Status
            </label>
            <select
              id="est-status"
              value={form.status}
              onChange={(e) =>
                set({ status: e.target.value as Establishment["status"] })
              }
              className={inputClass}
            >
              <option value="ativo">Ativo</option>
              <option value="inativo">Inativo</option>
            </select>
          </div>

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-gray-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-5 py-2.5 text-sm font-bold text-gray-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? (
                <>
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth={4}
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                    />
                  </svg>
                  Salvando...
                </>
              ) : isEditing ? (
                "Salvar alterações"
              ) : (
                "Criar estabelecimento"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modal de confirmação de exclusão de estabelecimento. */
function DeleteConfirmModal({
  establishment,
  isDeleting,
  error,
  onCancel,
  onConfirm,
}: {
  establishment: Establishment;
  isDeleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isDeleting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onCancel, isDeleting]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-gray-900 shadow-xl">
        <div className="px-5 py-5">
          <h2 className="text-lg font-bold text-white">
            Excluir estabelecimento
          </h2>
          <p className="mt-2 text-sm text-gray-400">
            A loja{" "}
            <span className="font-semibold text-gray-200">
              {establishment.name}
            </span>{" "}
            e a conta de acesso vinculada ({establishment.email}) serão
            removidas permanentemente.
          </p>
          {error && (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-gray-800 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className="rounded-xl border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isDeleting ? (
              <>
                <svg
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth={4}
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                  />
                </svg>
                Excluindo...
              </>
            ) : (
              "Excluir"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ícone de ação compacto usado nas linhas da tabela (desktop). */
function ActionIcon({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`rounded-lg p-2 transition ${
        danger
          ? "text-gray-500 hover:bg-red-500/10 hover:text-red-400"
          : "text-gray-500 hover:bg-gray-800 hover:text-yellow-300"
      }`}
    >
      {children}
    </button>
  );
}
