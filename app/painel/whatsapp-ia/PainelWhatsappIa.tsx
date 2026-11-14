"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminHeader } from "@/app/painel/components/AdminHeader";
import { useEstablishment } from "@/app/painel/produtos/useEstablishment";
import {
  EMPTY_WHATSAPP_AI_CONFIG,
  type WhatsappAiConfig,
} from "@/lib/whatsappAssistant";

/**
 * Metadados devolvidos por `GET`/`POST /api/whatsapp-ia`.
 *
 * O painel do estabelecimento é 100% operacional: nome do atendente, prompt
 * mestre, tom de voz e liga/desliga da IA são configuração da plataforma
 * (`/painel/admin/ia`) e nunca aparecem como campo aqui.
 */
interface PanelMeta {
  pauseMinutes: number;
  aiConfigured: boolean;
  evolutionConfigured: boolean;
}

/** Resposta de GET /api/whatsapp-ia. */
interface ConfigResponse {
  config?: WhatsappAiConfig;
  meta?: PanelMeta;
  migration_pending?: boolean;
  migration_hint?: string;
  error?: string;
}

/** Resposta de POST /api/whatsapp-ia (connect/status/disconnect). */
interface ConnectionResponse {
  qr?: {
    base64: string | null;
    code: string | null;
    pairing_code: string | null;
  };
  connected?: boolean;
  state?: string | null;
  qr_error?: string | null;
  instance?: string;
  already_disconnected?: boolean;
  message?: string;
  error?: string;
  meta?: PanelMeta;
}

/** QR Code em exibição (base64 da Evolution + código de pareamento). */
interface QrState {
  image: string | null;
  pairingCode: string | null;
  error: string | null;
}

/** De quanto em quanto tempo conferimos se o celular já leu o QR Code. */
const QR_STATUS_POLL_MS = 5000;

/** Estilo do seletor de loja (só o Superadmin troca de loja). */
const FIELD_CLASS =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-amber-500 disabled:bg-slate-100 disabled:text-slate-500";

const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-md shadow-yellow-400/30 transition hover:bg-yellow-300 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-60";

const DANGER_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * WhatsApp da loja — visão do ESTABELECIMENTO.
 *
 * A tela trata de um único assunto: **conexão do número**. Só existem dois
 * blocos — o estado da conexão (conectado/desconectado) e as ações
 * "Conectar WhatsApp" (com QR Code) e "Desconectar WhatsApp".
 *
 * O atendimento é feito pela IA, de forma autônoma, no número conectado: não
 * existe caixa de entrada, histórico de conversas nem campo de resposta, e o
 * sistema não persiste nenhuma mensagem
 * (`lib/whatsapp/conversationMemory.ts`).
 *
 * Prompt mestre, tom de voz, nome do atendente, liga/desliga da IA e a
 * instância da Evolution são GLOBAIS e ficam em `/painel/admin/ia`
 * (Superadmin). Aqui não existe nenhum campo de configuração.
 */
export function PainelWhatsappIa() {
  const {
    establishments,
    selectedId,
    isSuperAdmin,
    isLoading: isLoadingEst,
    error: estError,
    select,
  } = useEstablishment();

  const [config, setConfig] = useState<WhatsappAiConfig>({
    ...EMPTY_WHATSAPP_AI_CONFIG,
  });
  const [meta, setMeta] = useState<PanelMeta | null>(null);
  const [migrationPending, setMigrationPending] = useState(false);
  const [migrationHint, setMigrationHint] = useState<string | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Ação de conexão em andamento ("connect" | "disconnect").
  const [actionInFlight, setActionInFlight] = useState<
    "connect" | "disconnect" | null
  >(null);

  // QR Code na tela: só existe enquanto a sessão não está aberta no celular.
  const [qr, setQr] = useState<QrState | null>(null);

  // Descarta respostas fora de ordem quando o estabelecimento muda rápido.
  const requestSeq = useRef(0);

  const fetchConfig = useCallback(async () => {
    if (!selectedId) return;
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setError(null);
    setFeedback(null);
    // Trocar de loja (Superadmin) descarta o QR e os avisos da loja anterior.
    setQr(null);
    try {
      const res = await fetch(
        `/api/whatsapp-ia?establishment_id=${encodeURIComponent(selectedId)}`,
        { cache: "no-store" }
      );
      const data = (await res.json().catch(() => ({}))) as ConfigResponse;
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao carregar o atendente virtual.");
      }
      if (seq !== requestSeq.current) return;

      setConfig(data.config ?? { ...EMPTY_WHATSAPP_AI_CONFIG });
      setMeta(data.meta ?? null);
      setMigrationPending(data.migration_pending === true);
      setMigrationHint(data.migration_hint ?? null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await fetchConfig();
    })();
    return () => {
      active = false;
    };
  }, [fetchConfig]);

  /**
   * Ações de conexão do número (`POST /api/whatsapp-ia`).
   *
   * O dono da loja conecta/desconecta o próprio número; o Superadmin faz o
   * mesmo em qualquer loja. Devolve `null` quando não há loja selecionada.
   */
  const runAction = useCallback(
    async (
      action: "connect" | "status" | "disconnect"
    ): Promise<ConnectionResponse | null> => {
      if (!selectedId) return null;
      const res = await fetch("/api/whatsapp-ia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ establishment_id: selectedId, action }),
      });
      const data = (await res.json().catch(() => ({}))) as ConnectionResponse;
      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao falar com o WhatsApp.");
      }
      if (data.meta) setMeta(data.meta);
      return data;
    },
    [selectedId]
  );

  /** "Conectar WhatsApp": cria a instância e devolve o QR Code para o celular. */
  const handleConnect = useCallback(async () => {
    if (!selectedId) return;
    setActionInFlight("connect");
    setError(null);
    setFeedback(null);
    try {
      const data = await runAction("connect");
      if (!data) return;

      if (data.connected === true) {
        setQr(null);
        setConfig((prev) => ({ ...prev, whatsapp_connected: true }));
        setFeedback("WhatsApp já conectado.");
        return;
      }

      setQr({
        image: data.qr?.base64 ?? null,
        pairingCode: data.qr?.pairing_code ?? null,
        error: data.qr_error ?? null,
      });
      setFeedback(
        "QR Code gerado: leia com o WhatsApp do celular da loja em Dispositivos conectados."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setActionInFlight(null);
    }
  }, [runAction, selectedId]);

  /**
   * "Desconectar WhatsApp": encerra a sessão no aparelho atual.
   *
   * A instância continua existindo — depois de desconectar, "Conectar WhatsApp"
   * já devolve um QR Code novo para outro número.
   */
  const handleDisconnect = useCallback(async () => {
    if (!selectedId) return;
    setActionInFlight("disconnect");
    setError(null);
    setFeedback(null);
    try {
      const data = await runAction("disconnect");
      if (!data) return;

      setQr(null);
      setConfig((prev) => ({ ...prev, whatsapp_connected: false }));
      setFeedback(
        data.message ??
          "WhatsApp desconectado. Gere um novo QR Code para conectar outro número."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setActionInFlight(null);
    }
  }, [runAction, selectedId]);

  const hasQrOnScreen = qr !== null;

  // Com o QR na tela, confere de tempos em tempos se o celular já conectou.
  useEffect(() => {
    if (!hasQrOnScreen || !selectedId) return;
    let active = true;

    const timer = setInterval(async () => {
      try {
        const data = await runAction("status");
        if (!active || data?.connected !== true) return;
        setConfig((prev) => ({ ...prev, whatsapp_connected: true }));
        setQr(null);
        setFeedback("WhatsApp conectado.");
      } catch {
        // Silencioso: o polling tenta de novo no próximo intervalo.
      }
    }, QR_STATUS_POLL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [hasQrOnScreen, runAction, selectedId]);

  /** Lojas disponíveis para o seletor (somente Superadmin troca de loja). */
  const storeOptions = useMemo(
    () => (isSuperAdmin ? establishments : []),
    [establishments, isSuperAdmin]
  );

  const connected = config.whatsapp_connected === true;

  return (
    <div className="flex flex-1 flex-col">
      <AdminHeader establishmentId={selectedId} isSuperAdmin={isSuperAdmin} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Conexão do WhatsApp
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              Conecte o número da loja e a inteligência artificial da Ipepper
              passa a atender os clientes sozinha, com o cardápio e os dados da
              loja.
            </p>
          </div>

          {storeOptions.length > 1 && (
            <div>
              <label
                htmlFor="whatsapp-ia-loja"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Loja
              </label>
              <select
                id="whatsapp-ia-loja"
                value={selectedId ?? ""}
                onChange={(event) => select(event.target.value)}
                className={FIELD_CLASS}
              >
                {storeOptions.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {migrationPending && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {migrationHint ??
              "A migração do atendente virtual ainda não foi aplicada neste banco."}
          </p>
        )}

        {isSuperAdmin && meta && !meta.aiConfigured && (
          <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            A IA está sem chave configurada no servidor. Ajuste{" "}
            <code className="font-mono">GEMINI_API_KEY</code> em Configurações da
            plataforma → Atendente IA.
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

        {(error || estError) && (
          <p
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"
          >
            {error ?? estError}
          </p>
        )}

        <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                Status da conexão
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">
                O número conectado atende sozinho, pela IA. Para trocar de
                aparelho ou de número, desconecte a sessão atual e leia um novo
                QR Code.
              </p>
            </div>

            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold ${
                connected
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-slate-200 text-slate-700"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${
                  connected ? "bg-emerald-500" : "bg-slate-400"
                }`}
              />
              {connected ? "Conectado" : "Desconectado"}
            </span>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleConnect()}
              disabled={
                !selectedId || isLoading || isLoadingEst || actionInFlight !== null
              }
              className={PRIMARY_BUTTON_CLASS}
            >
              {actionInFlight === "connect"
                ? "Gerando QR Code…"
                : connected
                  ? "Gerar novo QR Code"
                  : "Conectar WhatsApp"}
            </button>

            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={
                !selectedId || isLoading || isLoadingEst || actionInFlight !== null
              }
              className={DANGER_BUTTON_CLASS}
            >
              {actionInFlight === "disconnect"
                ? "Desconectando…"
                : "Desconectar WhatsApp"}
            </button>
          </div>

          {!connected && !hasQrOnScreen && (
            <p className="text-sm text-slate-600">
              Nenhum número conectado. A IA começa a atender assim que o QR Code
              for lido.
            </p>
          )}

          {hasQrOnScreen && qr && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
              {qr.image ? (
                <>
                  {/* O QR chega como data URI da Evolution: não passa pelo
                      otimizador de imagens do Next. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qr.image}
                    alt="QR Code para conectar o WhatsApp da loja"
                    className="h-52 w-52"
                  />
                  <p className="text-center text-xs text-slate-600">
                    No celular da loja: WhatsApp → Dispositivos conectados →
                    Conectar dispositivo, e leia o código. Ele expira rápido — se
                    falhar, gere novamente.
                  </p>
                </>
              ) : (
                <p className="text-center text-xs text-slate-500">
                  A Evolution não devolveu a imagem do QR Code. Tente gerar
                  novamente.
                </p>
              )}

              {qr.pairingCode && (
                <p className="text-xs text-slate-600">
                  Código de pareamento:{" "}
                  <span className="font-mono font-bold">{qr.pairingCode}</span>
                </p>
              )}

              {qr.error && (
                <p className="text-center text-xs text-red-600">{qr.error}</p>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
