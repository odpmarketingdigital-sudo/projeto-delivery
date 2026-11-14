/**
 * POST /api/webhooks/whatsapp — recebe os eventos da Evolution API e opera o
 * atendente virtual de IA.
 *
 * Evento tratado: `messages.upsert` (mensagem nova na instância da loja).
 * Demais eventos (`connection.update`, `qrcode.updated`, …) são confirmados
 * com 200 e ignorados.
 *
 * Regras (ver `lib/whatsappAssistant.ts`):
 *  - grupos, listas de transmissão, status e canais são ignorados;
 *  - `key.fromMe = true` (loja respondeu pelo app) → PAUSA a IA por 30 min para
 *    aquele telefone (`lib/whatsapp/conversationMemory.ts`);
 *  - sem `ai_enabled` ou com a IA pausada, nenhuma resposta é enviada;
 *  - com a IA ativa: contexto recente + cardápio + dados da loja →
 *    `lib/ai/whatsappAgent` → resposta enviada pelo WhatsApp.
 *
 * **Privacidade:** nenhuma mensagem (enviada ou recebida) é gravada no banco.
 * O contexto de curto prazo e a pausa da IA vivem apenas na memória do processo
 * do servidor — ver `lib/whatsapp/conversationMemory.ts`. Por isso o painel não
 * tem histórico de conversas: o lojista acompanha o WhatsApp pelo aplicativo.
 *
 * O prompt é montado em camadas: prompt mestre global + tom de voz global
 * (`getGlobalAiSettings()`, editáveis só pelo Superadmin em `/painel/admin/ia`)
 * e, por cima do contexto da loja, apenas as observações operacionais que o
 * lojista escreveu (`ai_custom_instructions`). A loja nunca define regras do
 * atendimento nem parâmetros técnicos.
 *
 * Segurança: quando `WHATSAPP_WEBHOOK_TOKEN` está definido, o header
 * `x-webhook-token` (ou `?token=`) precisa coincidir — comparação em tempo
 * constante. Sem a variável, o endpoint aceita o evento (a Evolution não envia
 * token por padrão) e apenas registra um aviso no log.
 *
 * A loja é resolvida por `establishments.whatsapp_instance_name` (único).
 * Resposta é sempre 200 para eventos válidos: erro de IA ou de envio não deve
 * gerar reentrega infinita pela Evolution (ficam no log).
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getGlobalAiSettings } from "@/lib/ai/globalAiSettings";
import {
  buildWhatsappHistory,
  buildWhatsappSystemPrompt,
  generateWhatsAppReply,
  WhatsappAgentError,
  type WhatsappAgentCategory,
  type WhatsappAgentProduct,
  type WhatsappAgentStore,
} from "@/lib/ai/whatsappAgent";
import { createAdminClient } from "@/lib/supabase/server";
import {
  conversationTurns,
  isAiPausedForPhone,
  pauseAiForPhone,
  rememberConversationTurn,
} from "@/lib/whatsapp/conversationMemory";
import { normalizeCustomerPhone } from "@/lib/whatsappAssistant";
import {
  isIgnoredWhatsappJid,
  normalizeJidPhone,
  sendWhatsappText,
} from "@/lib/whatsapp/evolution";

/**
 * Roda no runtime Node (crypto + SDK do Gemini). Sem segment config: o projeto
 * usa `cacheComponents`, onde `runtime`/`dynamic` não são permitidos — a rota já
 * é dinâmica por ler headers e o corpo da requisição.
 */

/** Tamanho máximo de um turno guardado na memória (mesmo limite do envio). */
const MAX_TURN_LENGTH = 4000;

/** Colunas da loja usadas no prompt do atendente. */
const ESTABLISHMENT_COLUMNS = [
  "id",
  "name",
  "slug",
  "description",
  "phone",
  "whatsapp",
  "status",
  "opening_hours",
  "min_order_value",
  "accepted_meal_vouchers",
  "delivery_type",
  "delivery_fee",
  "estimated_delivery_time_min",
  "estimated_delivery_time_max",
  "ai_enabled",
  "ai_assistant_name",
  "ai_personality",
  "ai_custom_instructions",
  "whatsapp_instance_name",
].join(", ");

/** Loja resolvida pela instância. */
interface EstablishmentRow extends WhatsappAgentStore {
  id: string;
  status?: string | null;
  ai_enabled?: boolean | null;
  whatsapp_instance_name?: string | null;
}

/** Chave da mensagem no payload da Evolution. */
interface EvolutionMessageKey {
  remoteJid?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
  participant?: string | null;
}

/** Conteúdo da mensagem (varia por tipo do WhatsApp). */
interface EvolutionMessageContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null; fileName?: string | null } | null;
  buttonsResponseMessage?: { selectedDisplayText?: string | null } | null;
  templateButtonReplyMessage?: { selectedDisplayText?: string | null } | null;
  listResponseMessage?: {
    title?: string | null;
    singleSelectReply?: { selectedRowId?: string | null } | null;
  } | null;
}

/** Item de `data` em `messages.upsert`. */
interface EvolutionMessageData {
  key?: EvolutionMessageKey | null;
  pushName?: string | null;
  message?: EvolutionMessageContent | null;
  messageType?: string | null;
  messageTimestamp?: number | string | null;
  instanceName?: string | null;
}

/** Payload do webhook (campos usados; o resto é ignorado). */
interface EvolutionWebhookPayload {
  event?: string | null;
  instance?: string | null;
  instanceName?: string | null;
  data?: EvolutionMessageData | EvolutionMessageData[] | null;
}

/** Objeto JSON seguro (sem `any`). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Confere o token compartilhado. Sem `WHATSAPP_WEBHOOK_TOKEN` configurado o
 * evento é aceito (comportamento padrão da Evolution) — configure a variável e
 * o header `x-webhook-token` no painel da Evolution para bloquear chamadas
 * externas.
 */
function isAuthorized(request: Request): boolean {
  const expected = (process.env.WHATSAPP_WEBHOOK_TOKEN ?? "").trim();
  if (!expected) return true;

  const url = new URL(request.url);
  const provided =
    request.headers.get("x-webhook-token")?.trim() ||
    request.headers.get("apikey")?.trim() ||
    url.searchParams.get("token")?.trim() ||
    "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Texto enviado pelo cliente (conversa, texto estendido ou legenda de mídia). */
function extractMessageText(message: unknown): string {
  const content = asRecord(message);
  if (!content) return "";

  const candidates: unknown[] = [
    content.conversation,
    asRecord(content.extendedTextMessage)?.text,
    asRecord(content.imageMessage)?.caption,
    asRecord(content.videoMessage)?.caption,
    asRecord(content.documentMessage)?.caption,
    asRecord(content.buttonsResponseMessage)?.selectedDisplayText,
    asRecord(content.templateButtonReplyMessage)?.selectedDisplayText,
    asRecord(content.listResponseMessage)?.title,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

/** Normaliza `data` (objeto ou lista) em uma lista de mensagens. */
function toMessageDataList(payload: EvolutionWebhookPayload): EvolutionMessageData[] {
  if (Array.isArray(payload.data)) return payload.data;
  const single = asRecord(payload.data) as EvolutionMessageData | null;
  return single ? [single] : [];
}

/** Nome da instância informado pelo evento (varia entre versões da Evolution). */
function extractInstanceName(payload: EvolutionWebhookPayload): string {
  return String(
    payload.instance ?? payload.instanceName ?? ""
  ).trim();
}

/** Resultado do processamento de uma mensagem (vai na resposta do webhook). */
interface HandledMessage {
  phone?: string;
  skipped?: string;
  replied?: boolean;
  error?: string;
}

/**
 * Monta o prompt com o cardápio, recupera o contexto recente da conversa
 * (memória do processo, sem banco) e envia a resposta da IA. Erros viram
 * `HandledMessage.error` (o webhook continua respondendo 200).
 */
async function replyWithAi({
  store,
  phone,
  instanceName,
}: {
  store: EstablishmentRow;
  phone: string;
  instanceName: string;
}): Promise<HandledMessage> {
  const admin = createAdminClient();

  const [categoriesResult, productsResult] = await Promise.all([
    admin
      .from("categories")
      .select("id, name, position, sort_order, is_active")
      .eq("establishment_id", store.id),
    admin
      .from("products")
      .select("name, price, description, category_id, is_active, allow_half_half")
      .eq("establishment_id", store.id),
  ]);

  // Contexto de curto prazo mantido em memória — nada é lido/gravado no banco.
  const history = buildWhatsappHistory(conversationTurns(store.id, phone));

  // Prompt mestre, tom de voz e cadeia de modelos vêm da configuração GLOBAL
  // (`/painel/admin/ia`, chaves em `system_settings`). A loja contribui apenas
  // com dados operacionais (nome, horário, cardápio e observações).
  const globalAi = await getGlobalAiSettings();

  const systemPrompt = buildWhatsappSystemPrompt({
    store,
    categories: (categoriesResult.data ?? []) as WhatsappAgentCategory[],
    products: (productsResult.data ?? []) as WhatsappAgentProduct[],
    masterPrompt: globalAi.masterPrompt,
    personality: globalAi.defaultPersonality,
  });

  let reply: string;
  try {
    reply = await generateWhatsAppReply({
      systemPrompt,
      history,
      models: globalAi.models,
    });
  } catch (error) {
    const agentError =
      error instanceof WhatsappAgentError
        ? error
        : new WhatsappAgentError(502, "ai_request_failed", String(error));
    console.error(
      `[whatsapp-webhook] IA falhou (loja ${store.id}):`,
      agentError.code,
      agentError.message
    );
    return { phone, error: agentError.code };
  }

  // A resposta entra no contexto ANTES do envio: sem a Evolution configurada o
  // envio vira mock, mas a conversa continua coerente na próxima mensagem.
  rememberConversationTurn(store.id, phone, "assistant", reply);

  const sendResult = await sendWhatsappText({
    instanceName,
    phone,
    text: reply,
  });

  if (!sendResult.ok) {
    // Sem a Evolution configurada não há envio: a resposta gerada fica no log
    // para a loja conseguir responder manualmente pelo aplicativo.
    console.warn(
      "[whatsapp-webhook] resposta da IA não enviada:",
      JSON.stringify({
        store_id: store.id,
        instance: instanceName,
        phone,
        reason: sendResult.error ?? "send_failed",
        reply,
      })
    );
    return {
      phone,
      replied: false,
      error: sendResult.error ?? "send_failed",
    };
  }

  return { phone, replied: true };
}

/**
 * Processa UMA mensagem do evento: aplica a pausa/intervenção humana quando for
 * a loja respondendo e, quando permitido, aciona a IA. Nada é gravado no banco.
 */
async function handleMessage({
  store,
  instanceName,
  data,
}: {
  store: EstablishmentRow;
  instanceName: string;
  data: EvolutionMessageData;
}): Promise<HandledMessage> {
  const key = asRecord(data.key);
  const remoteJid = typeof key?.remoteJid === "string" ? key.remoteJid : "";

  // Grupos, listas de transmissão, status e canais nunca são respondidos.
  if (isIgnoredWhatsappJid(remoteJid)) return { skipped: "ignored_jid" };

  const phone = normalizeCustomerPhone(normalizeJidPhone(remoteJid));
  if (!phone) return { skipped: "invalid_phone" };

  const fromMe = key?.fromMe === true;
  const text = extractMessageText(data.message);

  // Loja respondeu pelo próprio WhatsApp → humano assumiu o atendimento.
  if (fromMe) {
    pauseAiForPhone(store.id, phone);

    if (text) {
      rememberConversationTurn(
        store.id,
        phone,
        "human_agent",
        text.slice(0, MAX_TURN_LENGTH)
      );
    }

    return { phone, skipped: "human_takeover" };
  }

  // Áudio/figurinha/imagem sem legenda: nada para interpretar.
  if (!text) return { phone, skipped: "no_text" };

  // A mensagem do cliente entra no contexto mesmo com a IA desligada/pausada:
  // quando ela voltar a responder, a conversa não recomeça do zero.
  rememberConversationTurn(
    store.id,
    phone,
    "user",
    text.slice(0, MAX_TURN_LENGTH)
  );

  if (store.ai_enabled !== true) return { phone, skipped: "ai_disabled" };
  if (store.status && store.status !== "ativo") {
    return { phone, skipped: "store_inactive" };
  }
  if (isAiPausedForPhone(store.id, phone)) {
    return { phone, skipped: "ai_paused" };
  }

  return replyWithAi({ store, phone, instanceName });
}

/** POST — entrada do webhook da Evolution API. */
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Token do webhook inválido." },
      { status: 401 }
    );
  }

  let payload: EvolutionWebhookPayload;
  try {
    payload = (await request.json()) as EvolutionWebhookPayload;
  } catch {
    return NextResponse.json(
      { error: "Payload inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const event = String(payload.event ?? "").trim();
  if (event && event !== "messages.upsert") {
    return NextResponse.json({ received: true, ignored: event });
  }

  const instanceName = extractInstanceName(payload);
  if (!instanceName) {
    return NextResponse.json({ received: true, ignored: "missing_instance" });
  }

  const admin = createAdminClient();
  const { data: storeRow, error: storeError } = await admin
    .from("establishments")
    .select(ESTABLISHMENT_COLUMNS)
    .eq("whatsapp_instance_name", instanceName)
    .maybeSingle();

  if (storeError) {
    // Sem a migração a coluna não existe: confirmar para a Evolution não
    // reenviar o evento para sempre.
    const migrationPending = /whatsapp_instance_name/i.test(
      storeError.message ?? ""
    );
    console.error(
      "[whatsapp-webhook] falha ao localizar a loja:",
      storeError.message
    );
    return NextResponse.json({
      received: true,
      ignored: migrationPending ? "migration_pending" : "store_lookup_failed",
    });
  }

  if (!storeRow) {
    return NextResponse.json({
      received: true,
      ignored: "unknown_instance",
      instance: instanceName,
    });
  }

  const store = storeRow as unknown as EstablishmentRow;
  const results: HandledMessage[] = [];

  // Sequencial de propósito: mensagens do mesmo cliente não podem gerar duas
  // respostas fora de ordem.
  for (const data of toMessageDataList(payload)) {
    results.push(await handleMessage({ store, instanceName, data }));
  }

  return NextResponse.json({ received: true, results });
}
