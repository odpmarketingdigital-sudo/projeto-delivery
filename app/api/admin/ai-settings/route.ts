/**
 * GET/PUT/POST /api/admin/ai-settings — configuração GLOBAL do atendente IA.
 *
 * Exclusivo do Super Admin (`requireSuperAdmin`): esta é a fronteira entre o
 * que a plataforma gerencia e o que a loja gerencia.
 *
 *  - GET  → prompt mestre em vigor, padrões (tom de voz, prefixo de instância,
 *           cadeia de modelos), estado das integrações (chaves de API presentes
 *           no servidor) e a lista de lojas com a instância de WhatsApp;
 *  - PUT  → salva `master_prompt`, `default_personality`, `instance_prefix` e
 *           `models` em `public.system_settings` (migração
 *           `20261112000002_add_global_ai_settings.sql`);
 *  - POST → `{ action: "ensure_instances" }` preenche o nome da instância das
 *           lojas que ainda não têm um (`<prefixo>-<slug>`), deixando todas as
 *           instâncias sob o padrão global.
 *
 * Nenhuma chave secreta passa por aqui: o painel só recebe "configurada" ou
 * "não configurada". As chaves continuam apenas nas variáveis de ambiente do
 * servidor (`GEMINI_API_KEY`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`,
 * `WHATSAPP_WEBHOOK_TOKEN`).
 */

import { NextResponse } from "next/server";
import {
  getGlobalAiSettings,
  saveGlobalAiSettings,
  type GlobalAiSettingsPatch,
} from "@/lib/ai/globalAiSettings";
import {
  isWhatsappAiConfigured,
  resolveWhatsappAiModels,
} from "@/lib/ai/whatsappAgent";
import { isSystemSettingsMissing } from "@/lib/settings";
import { requireSuperAdmin } from "@/lib/supabase/adminGuard";
import { createAdminClient } from "@/lib/supabase/server";
import {
  AI_PERSONALITY_OPTIONS,
  DEFAULT_AI_MASTER_PROMPT,
  DEFAULT_AI_PERSONALITY,
  DEFAULT_WHATSAPP_INSTANCE_PREFIX,
  MAX_AI_ASSISTANT_NAME_LENGTH,
  MAX_AI_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_AI_MASTER_PROMPT_LENGTH,
  MAX_AI_MODEL_NAME_LENGTH,
  MAX_WHATSAPP_INSTANCE_NAME_LENGTH,
  MAX_WHATSAPP_INSTANCE_PREFIX_LENGTH,
  aiPersonalityLabel,
  buildWhatsappInstanceName,
  isAiPersonality,
  normalizeAiModelList,
  normalizeInstancePrefix,
  normalizeMasterPrompt,
} from "@/lib/whatsappAssistant";
import { isEvolutionConfigured } from "@/lib/whatsapp/evolution";

/** Loja + instância de WhatsApp exibida no painel do Superadmin. */
interface StoreInstance {
  id: string;
  name: string;
  slug: string | null;
  /** Instância gravada em `establishments.whatsapp_instance_name`. */
  instanceName: string | null;
  /** Nome que a plataforma geraria com o prefixo atual (quando vazio). */
  suggestedInstanceName: string | null;
  connected: boolean;
  aiEnabled: boolean;
  /** Nome com que a IA se apresenta ao cliente (`ai_assistant_name`). */
  assistantName: string | null;
  /** Orientações próprias da loja (`ai_custom_instructions`). */
  customInstructions: string | null;
}

/** Linha crua de `establishments` (tolerante a migração pendente). */
interface StoreRow {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
  whatsapp_instance_name?: string | null;
  whatsapp_connected?: boolean | null;
  ai_enabled?: boolean | null;
  ai_assistant_name?: string | null;
  ai_custom_instructions?: string | null;
}

/** Erro HTTP padronizado (`{ error }`). */
function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** `true` quando o erro indica coluna/tabela ausente (migração pendente). */
function isSchemaError(message: string | undefined): boolean {
  const text = message ?? "";
  return /does not exist|schema cache|could not find|column .* does not exist/i.test(
    text
  );
}

/** Mensagem de erro do Supabase/JS sem expor detalhes internos. */
function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return error instanceof Error ? error.message : "";
}

/**
 * Lojas com a instância de WhatsApp, já com o nome sugerido pela plataforma.
 *
 * Falha de leitura não derruba o painel: sem as colunas de IA (migração
 * pendente) a lista volta vazia e a tela avisa.
 */
async function loadStoreInstances(instancePrefix: string): Promise<{
  stores: StoreInstance[];
  schemaPending: boolean;
}> {
  try {
    const adminClient = createAdminClient();
    const { data, error } = await adminClient
      .from("establishments")
      .select(
        "id, name, slug, whatsapp_instance_name, whatsapp_connected, ai_enabled, ai_assistant_name, ai_custom_instructions"
      )
      .order("name", { ascending: true });

    if (error) {
      if (isSchemaError(error.message)) {
        return { stores: [], schemaPending: true };
      }
      console.error("[admin/ai-settings] falha ao listar as lojas", error);
      return { stores: [], schemaPending: false };
    }

    const stores = ((data ?? []) as StoreRow[])
      .filter((row): row is StoreRow & { id: string } => Boolean(row.id))
      .map((row) => {
        const instanceName =
          typeof row.whatsapp_instance_name === "string" &&
          row.whatsapp_instance_name.trim()
            ? row.whatsapp_instance_name.trim()
            : null;

        const assistantName =
          typeof row.ai_assistant_name === "string" &&
          row.ai_assistant_name.trim()
            ? row.ai_assistant_name.trim()
            : null;
        const customInstructions =
          typeof row.ai_custom_instructions === "string" &&
          row.ai_custom_instructions.trim()
            ? row.ai_custom_instructions.trim()
            : null;

        return {
          id: row.id,
          name: (row.name ?? "").trim() || "Loja sem nome",
          slug: row.slug?.trim() || null,
          instanceName,
          suggestedInstanceName:
            instanceName ??
            buildWhatsappInstanceName(instancePrefix, row.slug ?? row.id),
          connected: row.whatsapp_connected === true,
          aiEnabled: row.ai_enabled === true,
          assistantName,
          customInstructions,
        };
      });

    return { stores, schemaPending: false };
  } catch (error) {
    console.error("[admin/ai-settings] erro ao listar as lojas", error);
    return { stores: [], schemaPending: false };
  }
}

/** Estado completo devolvido por GET, PUT e POST. */
async function respond(message?: string) {
  const settings = await getGlobalAiSettings();
  const { stores, schemaPending: storesSchemaPending } =
    await loadStoreInstances(settings.instancePrefix);

  return NextResponse.json({
    settings: {
      masterPrompt: settings.masterPrompt,
      masterPromptIsDefault: settings.masterPromptIsDefault,
      defaultPersonality: settings.defaultPersonality,
      defaultPersonalityLabel: aiPersonalityLabel(settings.defaultPersonality),
      instancePrefix: settings.instancePrefix,
      models: settings.models,
      schemaPending: settings.schemaPending,
      updatedAt: settings.updatedAt,
    },
    // Valores de fábrica: o painel usa para "restaurar padrão".
    defaults: {
      masterPrompt: DEFAULT_AI_MASTER_PROMPT,
      defaultPersonality: DEFAULT_AI_PERSONALITY,
      instancePrefix: DEFAULT_WHATSAPP_INSTANCE_PREFIX,
      models: resolveWhatsappAiModels(),
    },
    limits: {
      masterPrompt: MAX_AI_MASTER_PROMPT_LENGTH,
      modelName: MAX_AI_MODEL_NAME_LENGTH,
      instanceName: MAX_WHATSAPP_INSTANCE_NAME_LENGTH,
      instancePrefix: MAX_WHATSAPP_INSTANCE_PREFIX_LENGTH,
      // Limite das observações e do nome do atendente por loja.
      storeNotes: MAX_AI_CUSTOM_INSTRUCTIONS_LENGTH,
      assistantName: MAX_AI_ASSISTANT_NAME_LENGTH,
    },
    personalityOptions: AI_PERSONALITY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
    })),
    // Nunca enviamos a chave: apenas se ela existe no ambiente do servidor.
    integrations: {
      geminiConfigured: isWhatsappAiConfigured(),
      evolutionConfigured: isEvolutionConfigured(),
      webhookTokenConfigured: Boolean(
        process.env.WHATSAPP_WEBHOOK_TOKEN?.trim()
      ),
      webhookPath: "/api/webhooks/whatsapp",
      modelChain: resolveWhatsappAiModels(settings.models),
    },
    stores,
    storesSchemaPending,
    ...(message ? { message } : {}),
  });
}

/** GET — configuração global + lojas/instâncias. */
export async function GET() {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode ver a configuração global da IA."
  );
  if (!guard.ok) return guard.response;

  return respond();
}

/** Corpo aceito pelo PUT. */
interface AiSettingsPayload {
  master_prompt?: unknown;
  default_personality?: unknown;
  instance_prefix?: unknown;
  models?: unknown;
}

/**
 * Converte o corpo do PUT no patch tipado, validando cada campo presente.
 * Campos ausentes não são tocados (salvar o prompt não mexe nos modelos).
 */
function readPatch(
  body: AiSettingsPayload
): { patch: GlobalAiSettingsPatch } | { error: string } {
  const patch: GlobalAiSettingsPatch = {};
  let touched = false;

  if (body.master_prompt !== undefined) {
    if (typeof body.master_prompt !== "string") {
      return { error: "O prompt mestre deve ser um texto." };
    }
    if (body.master_prompt.trim().length > MAX_AI_MASTER_PROMPT_LENGTH) {
      return {
        error: `O prompt mestre deve ter no máximo ${MAX_AI_MASTER_PROMPT_LENGTH} caracteres.`,
      };
    }
    // Texto vazio restaura o padrão da plataforma.
    patch.masterPrompt = normalizeMasterPrompt(body.master_prompt);
    touched = true;
  }

  if (body.default_personality !== undefined) {
    if (!isAiPersonality(body.default_personality)) {
      return { error: "Tom de voz inválido. Use simpatico, direto ou formal." };
    }
    patch.defaultPersonality = body.default_personality;
    touched = true;
  }

  if (body.instance_prefix !== undefined) {
    if (typeof body.instance_prefix !== "string") {
      return { error: "O prefixo das instâncias deve ser um texto." };
    }
    const raw = body.instance_prefix.trim();
    const prefix = normalizeInstancePrefix(body.instance_prefix);
    if (raw && !/^[a-z0-9][a-z0-9._-]*$/.test(prefix)) {
      return {
        error:
          "Prefixo inválido: use letras, números, ponto, hífen ou sublinhado.",
      };
    }
    patch.instancePrefix = prefix;
    touched = true;
  }

  if (body.models !== undefined) {
    const isList = Array.isArray(body.models);
    const isText = typeof body.models === "string";

    if (body.models !== null && !isList && !isText) {
      return {
        error:
          "Envie os modelos como lista ou como texto separado por vírgulas.",
      };
    }

    const models = normalizeAiModelList(body.models);
    const informed = isList
      ? (body.models as unknown[]).filter(
          (item) => typeof item === "string" && item.trim().length > 0
        ).length
      : isText
        ? (body.models as string).split(",").filter((item) => item.trim()).length
        : 0;

    if (informed > 0 && models.length === 0) {
      return {
        error:
          "Nenhum modelo válido informado. Use nomes como gemini-3.8-flash.",
      };
    }

    // Lista vazia = volta a usar GEMINI_MODEL/GEMINI_MODEL_FALLBACKS.
    patch.models = models.length > 0 ? models : null;
    touched = true;
  }

  if (!touched) return { error: "Nada para salvar." };

  return { patch };
}

/** PUT — salva prompt mestre, tom de voz, prefixo e/ou modelos. */
export async function PUT(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode alterar a configuração global da IA."
  );
  if (!guard.ok) return guard.response;

  let body: AiSettingsPayload;
  try {
    body = (await request.json()) as AiSettingsPayload;
  } catch {
    return fail("Corpo da requisição inválido (JSON esperado).", 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Corpo da requisição inválido.", 400);
  }

  const parsed = readPatch(body);
  if ("error" in parsed) return fail(parsed.error, 400);

  try {
    await saveGlobalAiSettings(parsed.patch, guard.user.id);
  } catch (error) {
    const message = errorMessage(error);

    if (isSystemSettingsMissing({ message })) {
      return fail(
        "A tabela de configurações ainda não existe no banco. Execute a " +
          "migração 20261110000013_create_system_settings.sql e depois a " +
          "20261112000002_add_global_ai_settings.sql no SQL Editor do Supabase.",
        500
      );
    }

    console.error("[admin/ai-settings] falha ao salvar a configuração", error);
    return fail(
      "Não foi possível salvar a configuração global da IA. Tente novamente.",
      500
    );
  }

  return respond("Configuração global do atendente atualizada.");
}

/** Corpo aceito pelo POST. */
interface AiSettingsActionPayload {
  action?: unknown;
}

/**
 * POST — manutenção das instâncias globais.
 *
 * `{ action: "ensure_instances" }` preenche `whatsapp_instance_name` das lojas
 * que ainda não têm instância, no padrão `<prefixo>-<slug>`. É o passo que
 * coloca todas as instâncias sob o mesmo padrão da plataforma.
 */
export async function POST(request: Request) {
  const guard = await requireSuperAdmin(
    "Acesso negado. Apenas Super Admin pode administrar as instâncias de WhatsApp."
  );
  if (!guard.ok) return guard.response;

  let body: AiSettingsActionPayload = {};
  try {
    body = (await request.json()) as AiSettingsActionPayload;
  } catch {
    // Corpo vazio é aceito: a única ação é `ensure_instances`.
  }

  const action =
    typeof body.action === "string" ? body.action.trim().toLowerCase() : "";

  if (action !== "ensure_instances") {
    return fail("Ação inválida. Use ensure_instances.", 400);
  }

  const settings = await getGlobalAiSettings();
  const adminClient = createAdminClient();

  const { data, error } = await adminClient
    .from("establishments")
    .select("id, slug, whatsapp_instance_name");

  if (error) {
    if (isSchemaError(error.message)) {
      return fail(
        "As colunas do atendente virtual ainda não existem no banco. Execute a " +
          "migração 20261111000005_add_ai_whatsapp_assistant.sql no SQL Editor do Supabase.",
        500
      );
    }
    console.error(
      "[admin/ai-settings] falha ao carregar as instâncias das lojas",
      error
    );
    return fail(
      "Não foi possível carregar as lojas para gerar as instâncias.",
      500
    );
  }

  const rows = (data ?? []) as StoreRow[];
  const failures: string[] = [];
  let updated = 0;

  for (const row of rows) {
    if (!row.id) continue;

    const current =
      typeof row.whatsapp_instance_name === "string"
        ? row.whatsapp_instance_name.trim()
        : "";
    if (current) continue;

    const instanceName = buildWhatsappInstanceName(
      settings.instancePrefix,
      row.slug ?? row.id
    );

    if (!instanceName) {
      failures.push(`${row.id}: não foi possível derivar o nome da instância`);
      continue;
    }

    const { error: updateError } = await adminClient
      .from("establishments")
      .update({
        whatsapp_instance_name: instanceName,
        whatsapp_connected: false,
      })
      .eq("id", row.id);

    if (updateError) {
      failures.push(`${instanceName}: ${updateError.message}`);
      continue;
    }

    updated += 1;
  }

  const message =
    updated > 0
      ? `${updated} instância(s) gerada(s) no padrão ${settings.instancePrefix}-<slug>.`
      : "Todas as lojas já tinham instância configurada.";

  const response = await respond(message);

  if (failures.length === 0) return response;

  const payload = (await response.json()) as Record<string, unknown>;
  return NextResponse.json({ ...payload, failures }, { status: 200 });
}
