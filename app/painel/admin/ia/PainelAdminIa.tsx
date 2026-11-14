"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useAuth } from "@/context/AuthContext";

/**
 * Configuração GLOBAL do atendente IA (`/painel/admin/ia`).
 *
 * Tela exclusiva do Super Admin — é o outro lado da fronteira: tudo que é
 * global/sensível mora aqui.
 *  - prompt mestre do atendimento (vale para todas as lojas);
 *  - tom de voz padrão, prefixo das instâncias e cadeia de modelos Gemini;
 *  - estado das integrações (chaves de API nunca são exibidas, só o status);
 *  - instâncias de WhatsApp por loja, com o QR Code de conexão;
 *  - IA de cada loja: nome do atendente, liga/desliga e orientações.
 *
 * A loja fica apenas com a conexão do número em `/painel/whatsapp-ia`:
 * conectar (QR Code), desconectar e ver o estado. Nenhum campo de configuração
 * de IA aparece para o lojista — o sistema não guarda histórico de conversas e a
 * IA atende sozinha no número conectado.
 */

/** Resposta de GET/PUT/POST /api/admin/ai-settings. */
interface AdminAiSettingsResponse {
  settings?: {
    masterPrompt: string;
    masterPromptIsDefault: boolean;
    defaultPersonality: string;
    defaultPersonalityLabel: string;
    instancePrefix: string;
    models: string[] | null;
    schemaPending: boolean;
    updatedAt: string | null;
  };
  defaults?: {
    masterPrompt: string;
    defaultPersonality: string;
    instancePrefix: string;
    models: string[];
  };
  limits?: {
    masterPrompt: number;
    modelName: number;
    instanceName: number;
    instancePrefix: number;
    storeNotes: number;
    assistantName: number;
  };
  personalityOptions?: { value: string; label: string; description: string }[];
  integrations?: {
    geminiConfigured: boolean;
    evolutionConfigured: boolean;
    webhookTokenConfigured: boolean;
    webhookPath: string;
    modelChain: string[];
  };
  stores?: Array<{
    id: string;
    name: string;
    slug: string | null;
    instanceName: string | null;
    suggestedInstanceName: string | null;
    connected: boolean;
    aiEnabled: boolean;
    assistantName: string | null;
    customInstructions: string | null;
  }>;
  storesSchemaPending?: boolean;
  message?: string;
  failures?: string[];
  error?: string;
}

/** Resposta de POST /api/whatsapp-ia (conexão da instância). */
interface ConnectionResponse {
  qr?: {
    base64: string | null;
    code: string | null;
    pairing_code: string | null;
  };
  connected?: boolean;
  state?: string | null;
  qr_error?: string | null;
  state_error?: string | null;
  instance?: string;
  already_disconnected?: boolean;
  instance_deleted?: boolean;
  message?: string;
  error?: string;
}

/** Dados do QR Code exibidos por loja. */
interface QrState {
  image: string | null;
  pairingCode: string | null;
  error: string | null;
}

/** Resposta de PUT /api/whatsapp-ia (configuração de uma loja). */
interface StoreConfigResponse {
  error?: string;
  message?: string;
}

const FIELD_CLASS =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500 disabled:bg-slate-100 disabled:text-slate-500";

const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60";

const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50";

const DANGER_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50";

/** Badge de status de integração (chave presente/ausente no servidor). */
function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${
        ok ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {label}: {ok ? "configurada" : "ausente"}
    </span>
  );
}

export function PainelAdminIa() {
  const { currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "super_admin";

  const [data, setData] = useState<AdminAiSettingsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEnsuring, setIsEnsuring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Campos editáveis (espelham a configuração global).
  const [masterPrompt, setMasterPrompt] = useState("");
  const [personality, setPersonality] = useState("simpatico");
  const [instancePrefix, setInstancePrefix] = useState("");
  const [modelsInput, setModelsInput] = useState("");

  // QR Code em exibição por loja.
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [qrByStore, setQrByStore] = useState<Record<string, QrState>>({});

  // Editor da IA da loja: nome do atendente, liga/desliga e orientações.
  const [aiEditorStoreId, setAiEditorStoreId] = useState<string | null>(null);
  const [storeAiEnabled, setStoreAiEnabled] = useState(false);
  const [storeAssistantName, setStoreAssistantName] = useState("");
  const [storeInstructions, setStoreInstructions] = useState("");
  const [savingStoreAiId, setSavingStoreAiId] = useState<string | null>(null);

  /** Aplica a resposta da API nos campos do formulário. */
  const applyData = useCallback((next: AdminAiSettingsResponse) => {
    setData(next);
    if (!next.settings) return;

    setMasterPrompt(next.settings.masterPrompt);
    setPersonality(next.settings.defaultPersonality);
    setInstancePrefix(next.settings.instancePrefix);
    setModelsInput(
      (next.settings.models ?? next.defaults?.models ?? []).join(", ")
    );
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ai-settings", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as AdminAiSettingsResponse;
      if (!res.ok) {
        throw new Error(json.error ?? "Falha ao carregar a configuração global.");
      }
      applyData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsLoading(false);
    }
  }, [applyData]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await load();
    })();
    return () => {
      active = false;
    };
  }, [load]);

  /** PUT genérico: envia só o patch informado e atualiza a tela. */
  const savePatch = useCallback(
    async (body: Record<string, unknown>, successMessage: string) => {
      setIsSaving(true);
      setError(null);
      setFeedback(null);
      try {
        const res = await fetch("/api/admin/ai-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => ({}))) as AdminAiSettingsResponse;
        if (!res.ok) {
          throw new Error(json.error ?? "Falha ao salvar a configuração.");
        }
        applyData(json);
        setFeedback(successMessage);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro inesperado.");
      } finally {
        setIsSaving(false);
      }
    },
    [applyData]
  );

  const handleSavePrompt = useCallback(() => {
    void savePatch({ master_prompt: masterPrompt }, "Prompt mestre atualizado.");
  }, [masterPrompt, savePatch]);

  const handleRestorePrompt = useCallback(() => {
    const fallback = data?.defaults?.masterPrompt ?? "";
    setMasterPrompt(fallback);
    void savePatch(
      { master_prompt: fallback },
      "Prompt mestre restaurado para o padrão da plataforma."
    );
  }, [data, savePatch]);

  const handleSaveDefaults = useCallback(() => {
    void savePatch(
      {
        default_personality: personality,
        instance_prefix: instancePrefix,
        models: modelsInput,
      },
      "Padrões da plataforma atualizados."
    );
  }, [instancePrefix, modelsInput, personality, savePatch]);

  /** Preenche a instância das lojas que ainda estão sem nome. */
  const handleEnsureInstances = useCallback(async () => {
    setIsEnsuring(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await fetch("/api/admin/ai-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ensure_instances" }),
      });
      const json = (await res.json().catch(() => ({}))) as AdminAiSettingsResponse;
      if (!res.ok) {
        throw new Error(json.error ?? "Falha ao gerar as instâncias.");
      }
      applyData(json);
      setFeedback(json.message ?? "Instâncias verificadas.");
      if (json.failures && json.failures.length > 0) {
        setError(`Não foi possível gerar: ${json.failures.join("; ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setIsEnsuring(false);
    }
  }, [applyData]);

  /** Cria a instância na Evolution e devolve o QR Code para a loja ler. */
  const handleConnect = useCallback(
    async (storeId: string) => {
      setConnectingId(storeId);
      setError(null);
      setFeedback(null);
      try {
        const res = await fetch("/api/whatsapp-ia", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ establishment_id: storeId, action: "connect" }),
        });
        const json = (await res.json().catch(() => ({}))) as ConnectionResponse;
        if (!res.ok) {
          throw new Error(json.error ?? "Falha ao conectar o número.");
        }

        setQrByStore((prev) => ({
          ...prev,
          [storeId]: {
            image: json.qr?.base64 ?? null,
            pairingCode: json.qr?.pairing_code ?? null,
            error: json.qr_error ?? json.state_error ?? null,
          },
        }));
        setFeedback(
          json.connected
            ? "Número já conectado."
            : "QR Code gerado: leia com o WhatsApp da loja (Dispositivos conectados)."
        );
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro inesperado.");
      } finally {
        setConnectingId(null);
      }
    },
    [load]
  );

  /**
   * Encerra a sessão do número na Evolution (`action: "disconnect"`).
   *
   * A instância continua existindo: logo depois, "Conectar número" devolve um
   * QR Code novo sem precisar recriar nada.
   */
  const handleDisconnect = useCallback(
    async (storeId: string) => {
      setDisconnectingId(storeId);
      setError(null);
      setFeedback(null);
      try {
        const res = await fetch("/api/whatsapp-ia", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            establishment_id: storeId,
            action: "disconnect",
          }),
        });
        const json = (await res.json().catch(() => ({}))) as ConnectionResponse;
        if (!res.ok) {
          throw new Error(json.error ?? "Falha ao desconectar o WhatsApp.");
        }

        // O QR em exibição pertencia à sessão encerrada: some junto com ela.
        setQrByStore((prev) => {
          const next = { ...prev };
          delete next[storeId];
          return next;
        });
        setFeedback(
          json.message ??
            "WhatsApp desconectado. Gere um novo QR Code para reconectar."
        );
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro inesperado.");
      } finally {
        setDisconnectingId(null);
      }
    },
    [load]
  );

  /**
   * Abre o editor de IA da loja (nome do atendente, liga/desliga da IA e
   * orientações). Clicar de novo na mesma loja fecha o painel.
   */
  const toggleStoreAiEditor = useCallback(
    (store: {
      id: string;
      aiEnabled: boolean;
      assistantName: string | null;
      customInstructions: string | null;
    }) => {
      setAiEditorStoreId((prev) => (prev === store.id ? null : store.id));
      setStoreAiEnabled(store.aiEnabled);
      setStoreAssistantName(store.assistantName ?? "");
      setStoreInstructions(store.customInstructions ?? "");
      setError(null);
      setFeedback(null);
    },
    []
  );

  /**
   * Salva a IA da loja (`PUT /api/whatsapp-ia`).
   *
   * Nome do atendente, ativação e orientações são exclusivos do Superadmin: o
   * lojista não tem nenhum desses campos no painel dele.
   */
  const handleSaveStoreAi = useCallback(
    async (storeId: string) => {
      setSavingStoreAiId(storeId);
      setError(null);
      setFeedback(null);
      try {
        const res = await fetch("/api/whatsapp-ia", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            establishment_id: storeId,
            ai_enabled: storeAiEnabled,
            ai_assistant_name: storeAssistantName,
            ai_custom_instructions: storeInstructions,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as StoreConfigResponse;
        if (!res.ok) {
          throw new Error(json.error ?? "Falha ao salvar a IA da loja.");
        }
        setFeedback("Atendente da loja atualizado.");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro inesperado.");
      } finally {
        setSavingStoreAiId(null);
      }
    },
    [load, storeAiEnabled, storeAssistantName, storeInstructions]
  );

  const settings = data?.settings;
  const defaults = data?.defaults;
  const limits = data?.limits;
  const integrations = data?.integrations;
  const stores = data?.stores ?? [];
  const personalityOptions = useMemo(
    () => data?.personalityOptions ?? [],
    [data]
  );
  const personalityDescription =
    personalityOptions.find((option) => option.value === personality)
      ?.description ?? "";

  return (
    <div className="flex flex-1 flex-col">
      <AdminHeader isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Atendente IA da plataforma
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Configuração global do atendimento por WhatsApp: prompt mestre, tom
            de voz, cadeia de modelos, chaves de integração e as instâncias por
            loja. O lojista não tem acesso a nada desta tela.
          </p>
        </div>

        {data?.storesSchemaPending && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            A lista de lojas ficou vazia: rode a migração{" "}
            <code className="font-mono">
              20261112000001_add_whatsapp_ai.sql
            </code>{" "}
            para criar as colunas do atendente virtual.
          </p>
        )}

        {settings?.schemaPending && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            A tabela <code className="font-mono">system_settings</code> ainda não
            existe no banco. Execute{" "}
            <code className="font-mono">
              20261110000013_create_system_settings.sql
            </code>{" "}
            e depois{" "}
            <code className="font-mono">
              20261112000002_add_global_ai_settings.sql
            </code>{" "}
            no SQL Editor do Supabase para salvar as alterações.
          </p>
        )}

        {feedback && (
          <p
            role="status"
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
          >
            {feedback}
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"
          >
            {error}
          </p>
        )}

        <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Prompt mestre do atendimento
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                Regras que valem para TODAS as lojas. A loja complementa apenas
                com dados operacionais (nome, horário, cardápio e observações) —
                nunca com instruções técnicas.
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${
                settings?.masterPromptIsDefault
                  ? "bg-slate-100 text-slate-600"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${
                  settings?.masterPromptIsDefault
                    ? "bg-slate-400"
                    : "bg-amber-500"
                }`}
              />
              {settings?.masterPromptIsDefault
                ? "Padrão da plataforma"
                : "Personalizado"}
            </span>
          </div>

          <textarea
            id="admin-ai-master-prompt"
            aria-label="Prompt mestre do atendimento"
            value={masterPrompt}
            rows={14}
            maxLength={limits?.masterPrompt ?? 8000}
            onChange={(event) => setMasterPrompt(event.target.value)}
            disabled={isLoading}
            className={`${FIELD_CLASS} font-mono text-xs leading-relaxed`}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {masterPrompt.length}/{limits?.masterPrompt ?? 8000} caracteres
              {settings?.updatedAt
                ? ` · atualizado em ${new Date(settings.updatedAt).toLocaleString("pt-BR")}`
                : ""}
            </p>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void handleRestorePrompt()}
                disabled={isLoading || isSaving || !defaults}
                className={SECONDARY_BUTTON_CLASS}
              >
                Restaurar padrão
              </button>
              <button
                type="button"
                onClick={() => void handleSavePrompt()}
                disabled={isLoading || isSaving}
                className={PRIMARY_BUTTON_CLASS}
              >
                {isSaving ? "Salvando…" : "Salvar prompt mestre"}
              </button>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Padrões da plataforma
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Aplicados a todas as lojas. Não dependem do que a loja
                configurou.
              </p>
            </div>

            <div>
              <label
                htmlFor="admin-ai-personality"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Tom de voz do atendente
              </label>
              <select
                id="admin-ai-personality"
                value={personality}
                onChange={(event) => setPersonality(event.target.value)}
                disabled={isLoading}
                className={FIELD_CLASS}
              >
                {personalityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {personalityDescription && (
                <p className="mt-1.5 text-xs text-slate-500">
                  {personalityDescription}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="admin-ai-instance-prefix"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Prefixo das instâncias (Evolution API)
              </label>
              <input
                id="admin-ai-instance-prefix"
                type="text"
                value={instancePrefix}
                maxLength={limits?.instancePrefix ?? 30}
                onChange={(event) => setInstancePrefix(event.target.value)}
                disabled={isLoading}
                placeholder={defaults?.instancePrefix ?? "ipepper"}
                className={FIELD_CLASS}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Nome final:{" "}
                <span className="font-mono">
                  {instancePrefix || defaults?.instancePrefix || "ipepper"}-
                  &lt;slug-da-loja&gt;
                </span>
              </p>
            </div>

            <div>
              <label
                htmlFor="admin-ai-models"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Cadeia de modelos (ordem de tentativa)
              </label>
              <input
                id="admin-ai-models"
                type="text"
                value={modelsInput}
                onChange={(event) => setModelsInput(event.target.value)}
                disabled={isLoading}
                placeholder={defaults?.models.join(", ") ?? ""}
                className={`${FIELD_CLASS} font-mono text-xs`}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Separe por vírgulas. Vazio = usa{" "}
                <code className="font-mono">GEMINI_MODEL</code> e{" "}
                <code className="font-mono">GEMINI_MODEL_FALLBACKS</code> do
                ambiente.
                {integrations?.modelChain.length
                  ? ` Em uso agora: ${integrations.modelChain.join(" → ")}.`
                  : ""}
              </p>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleSaveDefaults()}
                disabled={isLoading || isSaving}
                className={PRIMARY_BUTTON_CLASS}
              >
                {isSaving ? "Salvando…" : "Salvar padrões"}
              </button>
            </div>
          </section>

          <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Integrações (chaves de API)
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                As chaves ficam apenas nas variáveis de ambiente do servidor.
                Aqui mostramos somente se estão presentes — nenhum valor é
                exibido nem salvo no banco.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <StatusBadge
                ok={integrations?.geminiConfigured === true}
                label="GEMINI_API_KEY"
              />
              <StatusBadge
                ok={integrations?.evolutionConfigured === true}
                label="EVOLUTION API"
              />
              <StatusBadge
                ok={integrations?.webhookTokenConfigured === true}
                label="WHATSAPP_WEBHOOK_TOKEN"
              />
            </div>

            <dl className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <dt className="font-semibold text-slate-700">Webhook</dt>
                <dd className="truncate font-mono text-xs text-slate-600">
                  {integrations?.webhookPath ?? "/api/webhooks/whatsapp"}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <dt className="font-semibold text-slate-700">Modelos em uso</dt>
                <dd className="text-right font-mono text-xs text-slate-600">
                  {(integrations?.modelChain ?? []).join(" → ") || "—"}
                </dd>
              </div>
            </dl>

            <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-xs leading-relaxed text-slate-600">
              Para trocar uma chave, atualize as variáveis de ambiente da
              hospedagem (Vercel → Settings → Environment Variables) e refaça o
              deploy. Nenhuma chave é editável pelo painel — nem pelo Superadmin.
            </p>
          </section>
        </div>

        <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Instâncias de WhatsApp e IA por loja
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                Um número por loja, criado e mantido pela plataforma. O nome segue
                o padrão <span className="font-mono">prefixo-slug</span> e o QR
                Code também é gerado aqui (o lojista só escaneia o dele). Em{" "}
                <span className="font-semibold">Configurar IA</span> ficam o nome
                do atendente, o liga/desliga da IA e as orientações da loja — nada
                disso é editável no painel do lojista.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleEnsureInstances()}
              disabled={isEnsuring || isLoading}
              className={SECONDARY_BUTTON_CLASS}
            >
              {isEnsuring ? "Gerando…" : "Gerar instâncias faltantes"}
            </button>
          </div>

          {stores.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 px-4 py-4 text-sm text-slate-500">
              Nenhuma loja cadastrada ainda.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {stores.map((store) => {
                const qr = qrByStore[store.id];
                const instanceName =
                  store.instanceName ?? store.suggestedInstanceName;

                return (
                  <li
                    key={store.id}
                    className="flex flex-col gap-3 rounded-xl border border-slate-200 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900">
                          {store.name}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {instanceName ? (
                            <span className="font-mono">{instanceName}</span>
                          ) : (
                            "sem instância definida"
                          )}
                          {!store.instanceName && instanceName
                            ? " (sugerida)"
                            : ""}
                          {store.slug ? ` · /${store.slug}` : ""}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${
                            store.connected
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`h-2 w-2 rounded-full ${
                              store.connected ? "bg-emerald-500" : "bg-slate-400"
                            }`}
                          />
                          {store.connected ? "Conectado" : "Desconectado"}
                        </span>

                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${
                            store.aiEnabled
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {store.aiEnabled ? "IA ativa" : "IA inativa"}
                        </span>

                        <button
                          type="button"
                          onClick={() => void handleConnect(store.id)}
                          disabled={
                            connectingId === store.id ||
                            disconnectingId === store.id
                          }
                          className={SECONDARY_BUTTON_CLASS}
                        >
                          {connectingId === store.id
                            ? "Gerando QR…"
                            : store.connected
                              ? "Verificar conexão"
                              : "Conectar número"}
                        </button>

                        {/* Encerra a sessão mantendo a instância: o botão de
                            conectar acima já devolve um QR Code novo. */}
                        {store.connected && (
                          <button
                            type="button"
                            onClick={() => void handleDisconnect(store.id)}
                            disabled={
                              disconnectingId === store.id ||
                              connectingId === store.id
                            }
                            className={DANGER_BUTTON_CLASS}
                          >
                            {disconnectingId === store.id
                              ? "Desconectando…"
                              : "Desconectar"}
                          </button>
                        )}
                        {/* IA da loja: nome do atendente, liga/desliga e
                            orientações. O lojista não tem esses campos. */}
                        <button
                          type="button"
                          onClick={() => toggleStoreAiEditor(store)}
                          disabled={savingStoreAiId === store.id}
                          aria-expanded={aiEditorStoreId === store.id}
                          className={SECONDARY_BUTTON_CLASS}
                        >
                          {aiEditorStoreId === store.id
                            ? "Fechar IA"
                            : "Configurar IA"}
                        </button>
                      </div>
                    </div>

                    {aiEditorStoreId === store.id && (
                      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm font-bold text-slate-900">
                            Atendente IA desta loja
                          </p>
                          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700">
                            <input
                              type="checkbox"
                              checked={storeAiEnabled}
                              onChange={(event) =>
                                setStoreAiEnabled(event.target.checked)
                              }
                              className="h-4 w-4 accent-amber-500"
                            />
                            {storeAiEnabled ? "IA ativa" : "IA inativa"}
                          </label>
                        </div>

                        <div>
                          <label
                            htmlFor={`admin-store-assistant-${store.id}`}
                            className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                          >
                            Nome do atendente
                          </label>
                          <input
                            id={`admin-store-assistant-${store.id}`}
                            type="text"
                            value={storeAssistantName}
                            maxLength={limits?.assistantName ?? 60}
                            onChange={(event) =>
                              setStoreAssistantName(event.target.value)
                            }
                            placeholder="Padrão da plataforma"
                            className={FIELD_CLASS}
                          />
                          <p className="mt-1.5 text-xs text-slate-500">
                            É o nome que o cliente vê na conversa. Em branco, usa
                            o padrão da plataforma.
                          </p>
                        </div>

                        <div>
                          <label
                            htmlFor={`admin-store-notes-${store.id}`}
                            className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                          >
                            Orientações da loja (opcional)
                          </label>
                          <textarea
                            id={`admin-store-notes-${store.id}`}
                            value={storeInstructions}
                            rows={4}
                            maxLength={limits?.storeNotes ?? 2000}
                            onChange={(event) =>
                              setStoreInstructions(event.target.value)
                            }
                            placeholder="Ex.: Não entregamos aos domingos. A partir das 22h só atendemos retirada no balcão."
                            className={FIELD_CLASS}
                          />
                          <p className="mt-1.5 text-xs text-slate-500">
                            {storeInstructions.length}/
                            {limits?.storeNotes ?? 2000} caracteres · complementa
                            as informações do cardápio.
                          </p>
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => void handleSaveStoreAi(store.id)}
                            disabled={savingStoreAiId === store.id}
                            className={PRIMARY_BUTTON_CLASS}
                          >
                            {savingStoreAiId === store.id
                              ? "Salvando…"
                              : "Salvar IA da loja"}
                          </button>
                        </div>
                      </div>
                    )}

                    {qr && (
                      <div className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                        {qr.image ? (
                          <>
                            {/* QR vem como data URI da Evolution: não passa pelo
                                otimizador de imagens do Next. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={qr.image}
                              alt={`QR Code para conectar o WhatsApp da loja ${store.name}`}
                              className="h-52 w-52"
                            />
                            <p className="text-center text-xs text-slate-600">
                              Abra o WhatsApp no celular da loja e leia o código.
                              Ele expira rápido: se falhar, gere novamente.
                            </p>
                          </>
                        ) : (
                          <p className="text-center text-xs text-slate-500">
                            A Evolution não devolveu a imagem do QR Code. Tente
                            novamente ou conecte pelo painel da Evolution API.
                          </p>
                        )}

                        {qr.pairingCode && (
                          <p className="text-xs text-slate-600">
                            Código de pareamento:{" "}
                            <span className="font-mono font-bold">
                              {qr.pairingCode}
                            </span>
                          </p>
                        )}

                        {qr.error && (
                          <p className="text-center text-xs text-red-600">
                            {qr.error}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
