/**
 * Cliente mínimo da Evolution API (WhatsApp) usado pelo atendente virtual.
 *
 * Só é executado no servidor — a `EVOLUTION_API_KEY` nunca vai ao navegador.
 * Endpoints usados (Evolution API v2):
 *  - `POST /message/sendText/{instance}`             envia texto
 *  - `GET  /instance/connectionState/{instance}`     estado do número
 *  - `POST /instance/create`                         cria a instância (+ webhook)
 *  - `GET  /instance/connect/{instance}`             QR Code / pairing code
 *  - `DELETE /instance/logout/{instance}`            encerra a sessão do número
 *  - `DELETE /instance/delete/{instance}`            remove uma instância órfã
 *
 * Sem `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` o sistema continua funcionando:
 * o webhook grava as mensagens e a resposta da IA, mas NÃO envia nada pelo
 * WhatsApp (o painel mostra o status "API não configurada").
 */

/** Tempo máximo de cada chamada (a Evolution pode demorar para gerar o QR). */
const REQUEST_TIMEOUT_MS = 12_000;

/** Configuração lida do ambiente (URL sem barra final). */
export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
}

/** Estado de conexão do número (`open` = conectado). */
export interface EvolutionConnectionState {
  /** Estado bruto devolvido pela Evolution (`open`, `close`, `connecting`…). */
  state: string | null;
  /** `state === "open"`. */
  connected: boolean;
  /** Mensagem de erro quando a consulta falhou. */
  error?: string;
}

/** QR Code para conectar o número. */
export interface EvolutionQrCode {
  /** Imagem em data URI (`data:image/png;base64,...`) ou null. */
  base64: string | null;
  /** Código do QR (string grande) para renderizar localmente, se necessário. */
  code: string | null;
  /** Código de pareamento de 8 dígitos (quando a Evolution devolve). */
  pairingCode: string | null;
}

/** Resultado da criação de instância. */
export interface EvolutionInstanceResult {
  ok: boolean;
  /** `true` quando a instância já existia (não é erro para o painel). */
  alreadyExists?: boolean;
  /**
   * QR Code devolvido pela própria criação (`qrcode: true`). Versões que só
   * geram o QR no `/instance/connect` devolvem `null` em todos os campos.
   */
  qrcode?: EvolutionQrCode;
  error?: string;
}

/** Resultado do envio de texto. */
export interface SendWhatsappTextResult {
  ok: boolean;
  error?: string;
}

/** Resultado da desconexão (logout) do número. */
export interface EvolutionDisconnectResult {
  ok: boolean;
  /** `true` quando a sessão já estava encerrada (não é erro para o painel). */
  alreadyDisconnected?: boolean;
  /** `true` quando a instância órfã foi removida da Evolution. */
  deleted?: boolean;
  error?: string;
}

/** Lê a configuração do ambiente (null quando não configurada). */
export function getEvolutionConfig(): EvolutionConfig | null {
  const baseUrl = (process.env.EVOLUTION_API_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = (process.env.EVOLUTION_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/** A Evolution API está configurada neste ambiente? */
export function isEvolutionConfigured(): boolean {
  return getEvolutionConfig() !== null;
}

/** Objeto JSON seguro (evita `any` nos payloads dinâmicos da Evolution). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Lê uma propriedade string não vazia. */
function readString(
  record: Record<string, unknown> | null,
  key: string
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * URL pública que recebe os eventos da Evolution.
 *
 * `WHATSAPP_WEBHOOK_URL` tem prioridade (útil quando a API roda em outro
 * domínio); sem ela usa `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_SITE_URL` + o
 * caminho do webhook. Sem nenhuma das duas a instância é criada sem webhook e o
 * painel continua funcionando (só não chegam mensagens).
 */
function getWebhookUrl(): string | null {
  const explicit = (process.env.WHATSAPP_WEBHOOK_URL ?? "").trim();
  if (explicit) return explicit;

  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "")
      .trim()
      .replace(/\/+$/, "");
  return base ? `${base}/api/webhooks/whatsapp` : null;
}

/** Headers que a Evolution envia nas chamadas do webhook (token opcional). */
function getWebhookHeaders(): Record<string, string> | null {
  const token = (process.env.WHATSAPP_WEBHOOK_TOKEN ?? "").trim();
  return token ? { "x-webhook-token": token } : null;
}

/** Garante `data:image/png;base64,...` (o painel usa direto em `<img src>`). */
function normalizeQrBase64(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
}

/** Bloco `webhook` do payload de criação (null quando a URL é desconhecida). */
function buildWebhookConfig(): Record<string, unknown> | null {
  const url = getWebhookUrl();
  if (!url) return null;

  const headers = getWebhookHeaders();
  return {
    url,
    byEvents: false,
    base64: false,
    events: ["MESSAGES_UPSERT"],
    ...(headers ? { headers } : {}),
  };
}

/**
 * Lê o QR de uma resposta da Evolution. A v2 devolve `{ base64, code,
 * pairingCode }` no `/instance/connect` e `{ qrcode: { base64, code } }` na
 * criação; os dois formatos são aceitos.
 */
function readQrCode(data: unknown): EvolutionQrCode {
  const record = asRecord(data);
  const nested = asRecord(record?.qrcode) ?? record;

  return {
    base64: normalizeQrBase64(readString(nested, "base64")),
    code: readString(nested, "code"),
    pairingCode: readString(nested, "pairingCode"),
  };
}

/**
 * Junta um campo `message` da Evolution em texto único.
 *
 * A v2 devolve `message` como **array** (`["The \"x\" instance is not
 * connected"]`) e/ou com objetos (`[{ message: "..." }]`).
 */
function readMessageList(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return null;

  const parts = value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = asRecord(item);
      return (
        readString(record, "message") ??
        readString(record, "description") ??
        readString(record, "detail")
      );
    })
    .filter((item): item is string => Boolean(item));

  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Extrai a mensagem de erro de um payload da Evolution.
 *
 * As exceções da v2 têm o formato
 * `{ status, error: "Bad Request", message: ["<detalhe>"] }`: `error` é apenas a
 * frase do status HTTP e o detalhe útil vem em `message` — quase sempre um
 * ARRAY. Ler `error` primeiro (como era feito antes) descartava esse detalhe e
 * fazia o painel exibir só "Bad Request".
 */
function extractApiError(data: unknown): string | null {
  if (typeof data === "string" && data.trim()) return data.trim();

  const record = asRecord(data);
  if (!record) return null;

  const response = asRecord(record.response);
  const detail =
    readMessageList(record.message) ??
    readMessageList(response?.message) ??
    readString(record, "detail") ??
    readString(response, "detail");
  if (detail) return detail;

  // `error`/`statusCode` são o último recurso (podem ser só "Bad Request").
  return readString(record, "error") ?? readString(response, "error");
}

/** Mensagem de erro de uma exceção de rede/timeout. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Tempo esgotado ao falar com a Evolution API.";
    }
    return error.message;
  }
  return String(error);
}

/**
 * Executa uma chamada autenticada e devolve JSON/erro já normalizados.
 *
 * O header `apikey` vai em TODAS as chamadas. O `Content-Type` só é enviado
 * quando há body: `DELETE /instance/logout/{instance}` não leva corpo e alguns
 * proxies/hospedagens recusam (`400`/`415`) um JSON vazio declarado.
 */
async function requestEvolution(
  config: EvolutionConfig,
  path: string,
  /**
   * `timeoutMs` permite usar um limite menor em chamadas que não podem travar a
   * requisição do usuário (ex.: notificações automáticas de pedido).
   */
  init: { method: string; body?: string; timeoutMs?: number } = { method: "GET" }
): Promise<{ ok: boolean; status: number; data: unknown; error: string | null }> {
  const headers: Record<string, string> = {
    apikey: config.apiKey,
    Accept: "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });

    let data: unknown = null;
    const raw = await response.text();
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        error: extractApiError(data) ?? `HTTP ${response.status}`,
      };
    }

    return { ok: true, status: response.status, data, error: null };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: errorMessage(error) };
  }
}

/** Remove o sufixo do JID e mantém somente os dígitos do telefone. */
export function normalizeJidPhone(jidOrPhone: string | null | undefined): string {
  const raw = String(jidOrPhone ?? "").trim();
  const withoutDomain = raw.includes("@") ? raw.split("@")[0] : raw;
  return withoutDomain.split(":")[0].replace(/\D/g, "");
}

/** JID usado pela Evolution no envio (`5517992650460@s.whatsapp.net`). */
export function buildWhatsappJid(phone: string | null | undefined): string | null {
  const digits = normalizeJidPhone(phone);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

/**
 * JIDs que o atendente virtual nunca responde: grupos, listas de transmissão,
 * status e canais (newsletter).
 */
export function isIgnoredWhatsappJid(jid: string | null | undefined): boolean {
  const value = String(jid ?? "").trim().toLowerCase();
  if (!value) return true;
  return (
    value.endsWith("@g.us") ||
    value.endsWith("@broadcast") ||
    value.endsWith("@newsletter") ||
    value === "status@broadcast"
  );
}

/**
 * Envia uma mensagem de texto pelo número conectado à instância.
 *
 * `phone` pode vir com máscara/DDI: só os dígitos são usados. O número precisa
 * estar no formato internacional (`55` + DDD + número), responsabilidade de quem
 * chama (ver `normalizeWhatsAppNumber` em `lib/whatsappOrder.ts`).
 *
 * `timeoutMs` é opcional: as notificações automáticas usam um limite curto para
 * nunca segurar a resposta do checkout.
 */
export async function sendWhatsappText({
  instanceName,
  phone,
  text,
  timeoutMs,
}: {
  instanceName: string;
  phone: string;
  text: string;
  timeoutMs?: number;
}): Promise<SendWhatsappTextResult> {
  const config = getEvolutionConfig();
  if (!config) {
    return {
      ok: false,
      error:
        "Evolution API não configurada (EVOLUTION_API_URL/EVOLUTION_API_KEY).",
    };
  }

  const number = normalizeJidPhone(phone);
  if (!number) return { ok: false, error: "Telefone do cliente inválido." };

  const result = await requestEvolution(
    config,
    `/message/sendText/${encodeURIComponent(instanceName)}`,
    {
      method: "POST",
      body: JSON.stringify({ number, text }),
      ...(timeoutMs ? { timeoutMs } : {}),
    }
  );

  return result.ok ? { ok: true } : { ok: false, error: result.error ?? undefined };
}

/** Consulta o estado de conexão do número. */
export async function fetchEvolutionConnectionState(
  instanceName: string
): Promise<EvolutionConnectionState> {
  const config = getEvolutionConfig();
  if (!config) {
    return {
      state: null,
      connected: false,
      error: "Evolution API não configurada.",
    };
  }

  const result = await requestEvolution(
    config,
    `/instance/connectionState/${encodeURIComponent(instanceName)}`
  );

  if (!result.ok) {
    return { state: null, connected: false, error: result.error ?? undefined };
  }

  const record = asRecord(result.data);
  const state =
    readString(asRecord(record?.instance), "state") ??
    readString(record, "state");

  return { state, connected: state === "open" };
}

/**
 * Cria a instância na Evolution (idempotente do ponto de vista do painel:
 * "já existe" — 403/409 — não é tratado como erro).
 *
 * Usa `POST /instance/create` (Evolution API v2) já com o webhook configurado,
 * então o número conectado passa a entregar `MESSAGES_UPSERT` sem ajuste manual.
 * Instalações antigas (v1) só têm `POST /instance`: o 404 do primeiro endpoint
 * cai no fallback.
 */
export async function createEvolutionInstance(
  instanceName: string
): Promise<EvolutionInstanceResult> {
  const config = getEvolutionConfig();
  if (!config) {
    return {
      ok: false,
      error:
        "Evolution API não configurada (EVOLUTION_API_URL/EVOLUTION_API_KEY).",
    };
  }

  const webhook = buildWebhookConfig();
  const body = JSON.stringify({
    instanceName,
    integration: "WHATSAPP-BAILEYS",
    qrcode: true,
    ...(webhook ? { webhook } : {}),
  });

  let result = await requestEvolution(config, "/instance/create", {
    method: "POST",
    body,
  });

  if (result.status === 404) {
    result = await requestEvolution(config, "/instance", {
      method: "POST",
      body,
    });
  }

  if (result.ok) {
    // A criação já devolve o QR em muitas versões: evita depender do
    // `/instance/connect`, que responde 404 enquanto a instância não existe.
    return { ok: true, qrcode: readQrCode(result.data) };
  }

  const message = (result.error ?? "").toLowerCase();
  const alreadyExists =
    result.status === 403 ||
    result.status === 409 ||
    message.includes("already") ||
    message.includes("já existe") ||
    message.includes("in use");

  if (alreadyExists) return { ok: true, alreadyExists: true };

  return { ok: false, error: result.error ?? undefined };
}

/** Pede o QR Code (ou pairing code) para conectar o número. */
export async function fetchEvolutionQrCode(
  instanceName: string
): Promise<EvolutionQrCode & { error?: string }> {
  const config = getEvolutionConfig();
  if (!config) {
    return {
      base64: null,
      code: null,
      pairingCode: null,
      error: "Evolution API não configurada.",
    };
  }

  const result = await requestEvolution(
    config,
    `/instance/connect/${encodeURIComponent(instanceName)}`
  );

  if (!result.ok) {
    return {
      base64: null,
      code: null,
      pairingCode: null,
      error: result.error ?? undefined,
    };
  }

  return readQrCode(result.data);
}

/**
 * Texto da Evolution que indica que a sessão já não está aberta.
 * A v2 responde 400 com `The "<instance>" instance is not connected` quando o
 * celular já desvinculou o aparelho.
 */
const SESSION_CLOSED_HINT =
  /not connected|not logged|no session|session closed|connection closed|already (disconnected|logged out)|já (está )?desconectad/i;

/**
 * Encerra a sessão do WhatsApp da instância (logout).
 *
 * Endpoint oficial da Evolution API v2:
 * `DELETE /instance/logout/{instanceName}` — o nome da instância vai no PATH e a
 * chave no header `apikey`; **não há body**. O `POST` no mesmo caminho é tentado
 * apenas como fallback quando o `DELETE` é barrado (proxy/hospedagem sem esse
 * método).
 *
 * O logout desvincula o aparelho mantendo a instância: o próximo
 * `/instance/connect` devolve um QR Code novo, que é exatamente o fluxo
 * "desconectar → gerar novo QR Code" do painel.
 *
 * Casos tratados como sucesso:
 *  - a sessão já estava encerrada (`Instance is not connected` / `no session`);
 *  - a Evolution respondeu 400 mas o `connectionState` confirma que o número não
 *    está mais `open` (é o 400 que a v2 devolve nesse cenário — antes ele
 *    aparecia no painel apenas como "Bad Request");
 *  - a instância não existe mais (`404`) → aí o endpoint de delete é chamado
 *    apenas para limpar o resíduo, e o próximo `connect` recria tudo (com
 *    webhook) sem intervenção manual.
 */
export async function disconnectEvolutionInstance(
  instanceName: string
): Promise<EvolutionDisconnectResult> {
  const config = getEvolutionConfig();
  if (!config) {
    return { ok: false, error: "Evolution API não configurada." };
  }

  // O nome vem do banco/painel: normaliza antes de montar a URL para não enviar
  // `" loja "` (espaço/quebra de linha) como identificador da instância.
  const name = String(instanceName ?? "").trim();
  if (!name) {
    return { ok: false, error: "Nome da instância do WhatsApp não informado." };
  }

  const encoded = encodeURIComponent(name);

  // 1) Endpoint oficial da v2: nome da instância no path, `apikey` no header.
  let logout = await requestEvolution(config, `/instance/logout/${encoded}`, {
    method: "DELETE",
  });

  if (logout.ok) return { ok: true };

  let message = (logout.error ?? "").toLowerCase();

  // 2) Já desconectado: o objetivo do botão já está cumprido.
  if (SESSION_CLOSED_HINT.test(message)) {
    return { ok: true, alreadyDisconnected: true };
  }

  // 3) Confirma o estado real antes de decidir. A v2 devolve 400
  //    {"status":400,"error":"Bad Request","message":["The \"x\" instance is not
  //    connected"]} quando a sessão já caiu no celular — sem esta checagem o
  //    painel marcava falha e a loja continuava como conectada no banco.
  const state = await fetchEvolutionConnectionState(name);
  if (!state.error && !state.connected) {
    return { ok: true, alreadyDisconnected: true };
  }

  // 4) Instância inexistente (`404`): remove o resíduo para o próximo `connect`
  //    recriar tudo com o webhook.
  const notFound =
    logout.status === 404 ||
    /not found|does not exist|não existe/i.test(message);
  if (notFound && state.error) {
    const removed = await requestEvolution(
      config,
      `/instance/delete/${encoded}`,
      { method: "DELETE" }
    );

    if (removed.ok || removed.status === 404) {
      return { ok: true, alreadyDisconnected: true, deleted: removed.ok };
    }

    return { ok: false, error: removed.error ?? logout.error ?? undefined };
  }

  // 5) Método barrado no caminho (proxy/hospedagem sem DELETE): repete via POST.
  //    A Evolution v2 aceita apenas o DELETE nesse endpoint, então o POST só é
  //    útil quando um intermediário reescreve o método.
  const methodBlocked =
    logout.status === 404 || logout.status === 405 || logout.status === 501;
  if (methodBlocked) {
    logout = await requestEvolution(config, `/instance/logout/${encoded}`, {
      method: "POST",
    });

    if (logout.ok) return { ok: true };

    message = (logout.error ?? "").toLowerCase();
    if (SESSION_CLOSED_HINT.test(message)) {
      return { ok: true, alreadyDisconnected: true };
    }
  }

  return { ok: false, error: logout.error ?? undefined };
}


