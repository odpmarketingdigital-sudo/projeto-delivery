/**
 * Memória **efêmera** das conversas do atendente virtual de WhatsApp.
 *
 * O Ipepper não persiste histórico de chat: nenhuma mensagem enviada ou
 * recebida é gravada no banco. Este módulo guarda, apenas na memória do
 * processo do servidor:
 *
 *  - os últimos turnos de cada conversa, para a IA não responder "do zero" no
 *    meio de um atendimento (contexto de curto prazo);
 *  - o instante em que a IA foi pausada porque alguém da loja respondeu pelo
 *    próprio aplicativo do WhatsApp (`key.fromMe = true`).
 *
 * Consequências aceitas (e documentadas no README):
 *  - reiniciar o processo zera o contexto e as pausas;
 *  - com várias instâncias do servidor, cada uma tem a própria memória.
 *
 * O módulo é usado só pelo webhook (`/api/webhooks/whatsapp`), que roda no
 * runtime Node. Nenhuma dependência de Supabase, Redis ou disco.
 */

import {
  AI_PAUSE_MINUTES,
  type WhatsappConversationRole,
} from "@/lib/whatsappAssistant";

/** Quantos turnos ficam disponíveis como contexto para o Gemini. */
export const MAX_CONVERSATION_TURNS = 30;

/** Tempo máximo que uma conversa fica na memória sem atividade. */
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Teto de conversas simultâneas (evita crescimento sem limite do processo). */
const MAX_CONVERSATIONS = 500;

/** Conversa em memória: turnos recentes + pausa da IA. */
interface ConversationMemory {
  turns: Array<{ role: WhatsappConversationRole; content: string }>;
  /** `0` = IA ativa; instante (epoch ms) em que a pausa expira. */
  pausedUntil: number;
  /** Última atividade — base do TTL e da remoção das conversas mais antigas. */
  updatedAt: number;
}

const conversations = new Map<string, ConversationMemory>();

/** Chave da conversa: uma por telefone dentro de cada loja. */
function conversationKey(establishmentId: string, phone: string): string {
  return `${establishmentId}:${phone}`;
}

/**
 * Descarta conversas inativas e, se ainda houver excesso, as mais antigas.
 * Roda apenas nas escritas — a leitura nunca paga esse custo.
 */
function prune(now: number): void {
  for (const [key, memory] of conversations) {
    if (now - memory.updatedAt > CONVERSATION_TTL_MS) conversations.delete(key);
  }

  const excess = conversations.size - MAX_CONVERSATIONS;
  if (excess <= 0) return;

  const oldestFirst = [...conversations.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  for (const [key] of oldestFirst.slice(0, excess)) conversations.delete(key);
}

/** Busca (ou cria) a conversa e renova o `updatedAt`. */
function touch(
  establishmentId: string,
  phone: string,
  now: number
): ConversationMemory {
  const key = conversationKey(establishmentId, phone);
  const existing = conversations.get(key);

  if (existing) {
    existing.updatedAt = now;
    return existing;
  }

  const created: ConversationMemory = {
    turns: [],
    pausedUntil: 0,
    updatedAt: now,
  };
  conversations.set(key, created);
  prune(now);
  return created;
}

/**
 * Guarda um turno da conversa (cliente, IA ou loja) e devolve os turnos que
 * ficaram retidos. Conteúdo vazio é ignorado.
 */
export function rememberConversationTurn(
  establishmentId: string,
  phone: string,
  role: WhatsappConversationRole,
  content: string,
  now: number = Date.now()
): void {
  const text = content.trim();
  if (!text) return;

  const memory = touch(establishmentId, phone, now);
  memory.turns.push({ role, content: text });

  if (memory.turns.length > MAX_CONVERSATION_TURNS) {
    memory.turns.splice(0, memory.turns.length - MAX_CONVERSATION_TURNS);
  }
}

/** Turnos recentes da conversa, do mais antigo para o mais novo. */
export function conversationTurns(
  establishmentId: string,
  phone: string,
  now: number = Date.now()
): Array<{ role: WhatsappConversationRole; content: string }> {
  const memory = conversations.get(conversationKey(establishmentId, phone));
  if (!memory || now - memory.updatedAt > CONVERSATION_TTL_MS) return [];
  return memory.turns.map((turn) => ({ ...turn }));
}

/**
 * Pausa a IA para este telefone (a loja assumiu o atendimento pelo app).
 * A pausa é renovada a cada mensagem enviada pela loja.
 */
export function pauseAiForPhone(
  establishmentId: string,
  phone: string,
  minutes: number = AI_PAUSE_MINUTES,
  now: number = Date.now()
): void {
  const memory = touch(establishmentId, phone, now);
  memory.pausedUntil = now + minutes * 60_000;
}

/** A IA está pausada para este telefone neste instante? */
export function isAiPausedForPhone(
  establishmentId: string,
  phone: string,
  now: number = Date.now()
): boolean {
  const memory = conversations.get(conversationKey(establishmentId, phone));
  if (!memory) return false;
  return memory.pausedUntil > now;
}
