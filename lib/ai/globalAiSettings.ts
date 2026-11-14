/**
 * Configuração GLOBAL do atendimento por IA — gerida pelo Superadmin.
 *
 * Fonte: `public.system_settings` (chave → valor JSON, migração
 * `20261110000013_create_system_settings.sql`, já com RLS de leitura exclusiva
 * do Superadmin). As chaves do atendente são criadas/seedadas pela migração
 * `20261112000002_add_global_ai_settings.sql`:
 *
 *  - `ai_master_prompt`        → `{ text: string }` prompt mestre do atendimento
 *                                (vale para TODAS as lojas);
 *  - `ai_default_personality`  → `{ value: "simpatico" | "direto" | "formal" }`
 *                                tom de voz padrão da plataforma;
 *  - `whatsapp_instance_prefix`→ `{ value: string }` prefixo das instâncias da
 *                                Evolution API (`ipepper-<slug>`);
 *  - `ai_models`               → `{ models: string[] }` cadeia de modelos
 *                                (`null`/vazio = usa `GEMINI_MODEL` +
 *                                `GEMINI_MODEL_FALLBACKS`).
 *
 * Módulo **somente servidor** (usa a service role key). As telas do Superadmin
 * consomem `/api/admin/ai-settings`; o webhook (`/api/webhooks/whatsapp`) chama
 * `getGlobalAiSettings()` para montar o prompt de cada resposta.
 *
 * Nunca importe este módulo em um Client Component: as chaves de API não são
 * gravadas aqui (continuam apenas em variáveis de ambiente do servidor) — o
 * painel recebe somente o estado "configurada/não configurada".
 */

import { SYSTEM_SETTINGS_TABLE, isSystemSettingsMissing } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/server";
import type { AiPersonality } from "@/lib/types";
import {
  DEFAULT_AI_MASTER_PROMPT,
  DEFAULT_AI_PERSONALITY,
  DEFAULT_WHATSAPP_INSTANCE_PREFIX,
  normalizeAiModelList,
  normalizeAiPersonality,
  normalizeInstancePrefix,
  normalizeMasterPrompt,
} from "@/lib/whatsappAssistant";

/** Chaves usadas em `system_settings` para o atendente virtual. */
export const AI_SETTING_KEYS = {
  masterPrompt: "ai_master_prompt",
  defaultPersonality: "ai_default_personality",
  instancePrefix: "whatsapp_instance_prefix",
  models: "ai_models",
} as const;

/** Descrições gravadas junto de cada chave (ajudam quem olha a tabela). */
export const AI_SETTING_DESCRIPTIONS = {
  masterPrompt:
    "Prompt mestre do atendente virtual de WhatsApp. Vale para todas as lojas e é editável apenas pelo Superadmin.",
  defaultPersonality:
    "Tom de voz padrão do atendente virtual (simpatico | direto | formal).",
  instancePrefix:
    "Prefixo das instâncias criadas na Evolution API (nome final: prefixo-slug-da-loja).",
  models:
    "Cadeia de modelos Gemini do atendimento, na ordem de tentativa. Vazio = usa GEMINI_MODEL/GEMINI_MODEL_FALLBACKS.",
} as const;

/** Configuração global efetiva do atendimento. */
export interface GlobalAiSettings {
  /** Prompt mestre em vigor (padrão da plataforma quando nada foi salvo). */
  masterPrompt: string;
  /** `true` quando o valor em vigor é o padrão de fábrica. */
  masterPromptIsDefault: boolean;
  /** Tom de voz aplicado a todas as lojas. */
  defaultPersonality: AiPersonality;
  /** Prefixo das instâncias da Evolution API. */
  instancePrefix: string;
  /**
   * Cadeia de modelos salva pelo Superadmin. `null` = nenhuma cadeia própria
   * configurada (o atendimento usa `resolveWhatsappAiModels()` do ambiente).
   */
  models: string[] | null;
  /** A tabela `system_settings` ainda não existe no banco. */
  schemaPending: boolean;
  /** Última atualização conhecida (ISO) de qualquer chave do atendente. */
  updatedAt: string | null;
}

/** Configuração de fábrica (usada quando o banco não respondeu). */
export function defaultGlobalAiSettings(
  schemaPending = false
): GlobalAiSettings {
  return {
    masterPrompt: DEFAULT_AI_MASTER_PROMPT,
    masterPromptIsDefault: true,
    defaultPersonality: DEFAULT_AI_PERSONALITY,
    instancePrefix: DEFAULT_WHATSAPP_INSTANCE_PREFIX,
    models: null,
    schemaPending,
    updatedAt: null,
  };
}

/** Linha lida de `system_settings` (só os campos usados aqui). */
interface SystemSettingRow {
  key?: string | null;
  value?: unknown;
  updated_at?: string | null;
}

/**
 * Texto de um valor jsonb aceito nos formatos `{ text }`, `{ value }`,
 * `{ prompt }` ou string solta. Qualquer outra coisa → `null`.
 */
function readSettingText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? value : null;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "value", "prompt"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }

  return null;
}

/** Cadeia de modelos de um valor jsonb (`{ models }`, array ou string). */
function readSettingModels(value: unknown): string[] {
  if (Array.isArray(value) || typeof value === "string") {
    return normalizeAiModelList(value);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return normalizeAiModelList(record.models ?? record.value ?? record.list);
  }

  return [];
}

/**
 * Lê a configuração global do atendimento.
 *
 * Nunca lança: tabela ausente (migração pendente), service role indisponível ou
 * erro de rede caem na configuração de fábrica — o atendimento continua
 * funcionando com o prompt mestre padrão.
 */
export async function getGlobalAiSettings(): Promise<GlobalAiSettings> {
  try {
    const adminClient = createAdminClient();

    const { data, error } = await adminClient
      .from(SYSTEM_SETTINGS_TABLE)
      .select("key, value, updated_at")
      .in("key", Object.values(AI_SETTING_KEYS));

    if (error) {
      if (isSystemSettingsMissing(error)) {
        return defaultGlobalAiSettings(true);
      }

      console.error(
        "[ai-settings] falha ao ler a configuração global do atendente",
        error
      );
      return defaultGlobalAiSettings(false);
    }

    const rows = (data ?? []) as SystemSettingRow[];
    const byKey = new Map<string, SystemSettingRow>();
    for (const row of rows) {
      if (typeof row.key === "string" && row.key.length > 0) {
        byKey.set(row.key, row);
      }
    }

    const savedPrompt = readSettingText(
      byKey.get(AI_SETTING_KEYS.masterPrompt)?.value
    );
    const masterPrompt = normalizeMasterPrompt(savedPrompt);
    const models = readSettingModels(
      byKey.get(AI_SETTING_KEYS.models)?.value
    );

    let updatedAt: string | null = null;
    for (const row of rows) {
      if (typeof row.updated_at !== "string") continue;
      if (updatedAt === null || row.updated_at > updatedAt) {
        updatedAt = row.updated_at;
      }
    }

    return {
      masterPrompt,
      masterPromptIsDefault: masterPrompt === DEFAULT_AI_MASTER_PROMPT,
      defaultPersonality: normalizeAiPersonality(
        readSettingText(byKey.get(AI_SETTING_KEYS.defaultPersonality)?.value)
      ),
      instancePrefix: normalizeInstancePrefix(
        readSettingText(byKey.get(AI_SETTING_KEYS.instancePrefix)?.value)
      ),
      models: models.length > 0 ? models : null,
      schemaPending: false,
      updatedAt,
    };
  } catch (error) {
    console.error(
      "[ai-settings] erro inesperado ao ler a configuração global do atendente",
      error
    );
    return defaultGlobalAiSettings(false);
  }
}

/** Alterações aceitas ao salvar a configuração global. */
export interface GlobalAiSettingsPatch {
  /** Texto do prompt mestre (vazio = volta ao padrão da plataforma). */
  masterPrompt?: string;
  /** Tom de voz padrão da plataforma. */
  defaultPersonality?: AiPersonality;
  /** Prefixo das instâncias (vazio = prefixo padrão). */
  instancePrefix?: string;
  /** Cadeia de modelos; `null`/vazio = usar as variáveis de ambiente. */
  models?: string[] | null;
}

/**
 * Grava a configuração global em `system_settings` (upsert por chave).
 *
 * Só as chaves informadas no patch são tocadas — assim salvar o prompt mestre
 * não sobrescreve os modelos, e vice-versa. Lança o erro do Supabase para a
 * rota responder com a mensagem correta (ex.: migração pendente).
 */
export async function saveGlobalAiSettings(
  patch: GlobalAiSettingsPatch,
  updatedBy?: string | null
): Promise<void> {
  const rows: Array<{
    key: string;
    value: Record<string, unknown>;
    description: string;
    updated_by: string | null;
  }> = [];

  const author = updatedBy ?? null;

  if (patch.masterPrompt !== undefined) {
    rows.push({
      key: AI_SETTING_KEYS.masterPrompt,
      value: { text: normalizeMasterPrompt(patch.masterPrompt) },
      description: AI_SETTING_DESCRIPTIONS.masterPrompt,
      updated_by: author,
    });
  }

  if (patch.defaultPersonality !== undefined) {
    rows.push({
      key: AI_SETTING_KEYS.defaultPersonality,
      value: { value: normalizeAiPersonality(patch.defaultPersonality) },
      description: AI_SETTING_DESCRIPTIONS.defaultPersonality,
      updated_by: author,
    });
  }

  if (patch.instancePrefix !== undefined) {
    rows.push({
      key: AI_SETTING_KEYS.instancePrefix,
      value: { value: normalizeInstancePrefix(patch.instancePrefix) },
      description: AI_SETTING_DESCRIPTIONS.instancePrefix,
      updated_by: author,
    });
  }

  if (patch.models !== undefined) {
    rows.push({
      key: AI_SETTING_KEYS.models,
      value: { models: normalizeAiModelList(patch.models) },
      description: AI_SETTING_DESCRIPTIONS.models,
      updated_by: author,
    });
  }

  if (rows.length === 0) return;

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from(SYSTEM_SETTINGS_TABLE)
    .upsert(rows, { onConflict: "key" });

  if (error) throw error;
}
