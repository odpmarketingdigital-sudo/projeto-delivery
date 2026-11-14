/**
 * GET/PUT/POST /api/whatsapp-ia — configuração do atendente virtual de WhatsApp.
 *
 * `GET`  devolve a configuração da loja + os limites/opções exibidos no painel.
 * `PUT`  salva a configuração (ligar/desligar, nome, personalidade, instruções
 *        e nome da instância na Evolution API).
 * `POST` executa ações de conexão do número: `{ action: "connect" }` cria a
 *        instância (`POST /instance/create`, já com o webhook) e devolve o QR
 *        Code; `{ action: "status" }` atualiza o estado de conexão
 *        (`establishments.whatsapp_connected`); `{ action: "disconnect" }`
 *        encerra a sessão do WhatsApp (`DELETE /instance/logout/{instance}`,
 *        nome no path, sem body), marca a loja como desconectada e libera a
 *        geração de um novo QR Code.
 *
 * Segurança: sessão obrigatória e o mesmo guard do cardápio
 * (`requireMenuAccess` + `resolveMenuEstablishment`): o dono só acessa a própria
 * loja; o super admin pode informar `establishment_id`.
 *
 * **Divisão de responsabilidades (Superadmin × Estabelecimento):**
 *  - loja (`POST`) → apenas operação: `connect`/`status`/`disconnect` (o dono
 *    conecta e desconecta o PRÓPRIO número). Nenhuma configuração de IA e
 *    nenhum histórico de conversas — o sistema não persiste mensagens;
 *  - plataforma (`PUT` daqui + `/api/admin/ai-settings`, só Superadmin) → prompt
 *    mestre, tom de voz padrão, cadeia de modelos, nome do atendente, liga/
 *    desliga da IA, observações da loja, instância da Evolution e QR Code.
 *    `PUT` de quem não é Superadmin responde `403`; `whatsapp_instance_name`
 *    volta como `null` no `GET` de quem não é Superadmin.
 *
 * Compatibilidade: se a migração `20261111000005_add_ai_whatsapp_assistant.sql`
 * ainda não rodou, a rota responde 200 com `migration_pending: true` e a
 * configuração padrão (o painel exibe o aviso em vez de quebrar).
 */

import { NextResponse } from "next/server";
import { getGlobalAiSettings } from "@/lib/ai/globalAiSettings";
import { isWhatsappAiConfigured } from "@/lib/ai/whatsappAgent";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import {
  AI_PAUSE_MINUTES,
  AI_PERSONALITY_OPTIONS,
  EMPTY_WHATSAPP_AI_CONFIG,
  MAX_AI_ASSISTANT_NAME_LENGTH,
  MAX_AI_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_WHATSAPP_INSTANCE_NAME_LENGTH,
  aiPersonalityLabel,
  buildWhatsappInstanceName,
  isAiPersonality,
  normalizeAiPersonality,
  normalizeAssistantName,
  normalizeCustomInstructions,
  normalizeWhatsappInstanceName,
  toWhatsappAiConfig,
  type WhatsappAiConfig,
  type WhatsappAiConfigRow,
} from "@/lib/whatsappAssistant";
import {
  createEvolutionInstance,
  disconnectEvolutionInstance,
  fetchEvolutionConnectionState,
  fetchEvolutionQrCode,
  isEvolutionConfigured,
} from "@/lib/whatsapp/evolution";

/**
 * Roda no runtime Node (envio/consulta na Evolution API). Sem segment config: o
 * projeto usa `cacheComponents`, onde `runtime`/`dynamic` não são permitidos — a
 * rota já é dinâmica por ler a sessão (cookies) e a querystring.
 */

/** Colunas da configuração do atendente. */
const CONFIG_COLUMNS =
  "ai_enabled, ai_assistant_name, ai_personality, ai_custom_instructions, whatsapp_instance_name, whatsapp_connected";

/** Mensagem para bancos sem a migração aplicada. */
const MIGRATION_HINT =
  "Execute a migração 20261111000005_add_ai_whatsapp_assistant.sql no SQL Editor do Supabase para habilitar o atendente virtual.";

/** `true` quando o erro é de coluna/tabela ausente (migração pendente). */
function isSchemaError(message: string | undefined): boolean {
  const text = message ?? "";
  return /does not exist|schema cache|could not find|column .* does not exist/i.test(
    text
  );
}

/**
 * Resolve a loja alvo da requisição com o mesmo guard do cardápio.
 * `bodyEstablishmentId` tem prioridade sobre a querystring.
 */
async function resolveRequestEstablishment(
  request: Request,
  bodyEstablishmentId?: unknown
): Promise<{ id: string; isSuperAdmin: boolean } | { response: NextResponse }> {
  const guard = await requireMenuAccess();
  if (!guard.ok) return { response: guard.response };

  const requested =
    (typeof bodyEstablishmentId === "string" && bodyEstablishmentId.trim()) ||
    new URL(request.url).searchParams.get("establishment_id");

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    requested
  );
  if ("response" in resolved) return { response: resolved.response };

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return {
      response: NextResponse.json(
        { error: "Você não tem acesso ao atendente virtual desta loja." },
        { status: 403 }
      ),
    };
  }

  return { id: resolved.id, isSuperAdmin: guard.isSuperAdmin };
}

/**
 * Opções/limites/estado das integrações exibidos pelo painel.
 *
 * `platformPersonality` é a fronteira de permissão do tom de voz (define-se em
 * `/painel/admin/ia`); `canManageConnection` é sempre `true` porque o guard da
 * rota garante que só o dono da loja ou o Superadmin chegam aqui — conectar e
 * desconectar o número é operação da loja.
 */
async function panelMeta() {
  const globalAi = await getGlobalAiSettings();

  return {
    personalities: AI_PERSONALITY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
    })),
    limits: {
      assistantName: MAX_AI_ASSISTANT_NAME_LENGTH,
      customInstructions: MAX_AI_CUSTOM_INSTRUCTIONS_LENGTH,
      instanceName: MAX_WHATSAPP_INSTANCE_NAME_LENGTH,
    },
    pauseMinutes: AI_PAUSE_MINUTES,
    aiConfigured: isWhatsappAiConfigured(),
    evolutionConfigured: isEvolutionConfigured(),
    webhookPath: "/api/webhooks/whatsapp",
    // Conectar/desconectar é operação da loja: o guard acima já garantiu que
    // quem chama é o dono do estabelecimento ou o Superadmin.
    canManageConnection: true,
    platformPersonality: {
      value: globalAi.defaultPersonality,
      label: aiPersonalityLabel(globalAi.defaultPersonality),
      description:
        AI_PERSONALITY_OPTIONS.find(
          (option) => option.value === globalAi.defaultPersonality
        )?.description ?? "",
    },
  };
}

/**
 * Remove da resposta o que é gerido pela plataforma.
 *
 * O nome da instância da Evolution é um identificador técnico global: só o
 * Superadmin precisa vê-lo. Para a loja o status de conexão é suficiente.
 */
function configForViewer(
  config: WhatsappAiConfig,
  isSuperAdmin: boolean
): WhatsappAiConfig {
  return isSuperAdmin ? config : { ...config, whatsapp_instance_name: null };
}

/**
 * GET /api/whatsapp-ia?establishment_id=xxx
 *
 * Devolve a configuração do atendente virtual e os metadados do painel.
 */
export async function GET(request: Request) {
  const target = await resolveRequestEstablishment(request);
  if ("response" in target) return target.response;

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("establishments")
    .select(CONFIG_COLUMNS)
    .eq("id", target.id)
    .maybeSingle();

  if (error) {
    if (isSchemaError(error.message)) {
      return NextResponse.json(
        {
          config: { ...EMPTY_WHATSAPP_AI_CONFIG },
          meta: await panelMeta(),
          migration_pending: true,
          migration_hint: MIGRATION_HINT,
        },
        { status: 200 }
      );
    }

    console.error(
      "[whatsapp-ia] falha ao carregar a configuração:",
      error.message
    );
    return NextResponse.json(
      { error: "Falha ao carregar a configuração do atendente virtual." },
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      config: configForViewer(
        toWhatsappAiConfig(data as WhatsappAiConfigRow | null),
        target.isSuperAdmin
      ),
      meta: await panelMeta(),
      migration_pending: false,
    },
    { status: 200 }
  );
}

/** Campos aceitos pelo PUT. */
interface WhatsappAiPayload {
  establishment_id?: unknown;
  ai_enabled?: unknown;
  ai_assistant_name?: unknown;
  ai_personality?: unknown;
  ai_custom_instructions?: unknown;
  whatsapp_instance_name?: unknown;
}

/**
 * PUT /api/whatsapp-ia — salva a configuração do atendente virtual.
 *
 * Body: { establishment_id? (super_admin), ai_enabled?, ai_assistant_name?,
 *         ai_personality?, ai_custom_instructions?, whatsapp_instance_name? }
 *
 * **Somente Superadmin**: nome do atendente, liga/desliga da IA e observações
 * são configuração da plataforma (a loja só conecta o número e atende). Trocar/
 * remover o nome da instância marca o número como desconectado até uma nova
 * consulta de status.
 */
export async function PUT(request: Request) {
  let body: WhatsappAiPayload;
  try {
    body = (await request.json()) as WhatsappAiPayload;
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const target = await resolveRequestEstablishment(
    request,
    body.establishment_id
  );
  if ("response" in target) return target.response;

  // Configuração do atendente = plataforma. A loja enxerga apenas a conexão do
  // número; o sistema não guarda histórico de conversas.
  if (!target.isSuperAdmin) {
    return NextResponse.json(
      {
        error:
          "As configurações do atendente virtual são definidas pela plataforma Ipepper. Fale com o suporte para alterar o nome, a ativação ou as orientações da IA.",
      },
      { status: 403 }
    );
  }

  const patch: Record<string, unknown> = {};

  if (body.ai_enabled !== undefined) {
    patch.ai_enabled = body.ai_enabled === true;
  }

  if (body.ai_assistant_name !== undefined) {
    patch.ai_assistant_name = normalizeAssistantName(body.ai_assistant_name);
  }

  // Tom de voz é definido pela plataforma (`ai_default_personality`). Um
  // lojista que envie o campo é ignorado, e não recebe erro: o painel dele nem
  // exibe mais essa opção.
  if (body.ai_personality !== undefined && target.isSuperAdmin) {
    const raw =
      typeof body.ai_personality === "string"
        ? body.ai_personality.trim().toLowerCase()
        : "";
    if (!isAiPersonality(raw)) {
      return NextResponse.json(
        {
          error:
            "Personalidade inválida. Use simpatico, direto ou formal.",
        },
        { status: 400 }
      );
    }
    patch.ai_personality = normalizeAiPersonality(raw);
  }

  if (body.ai_custom_instructions !== undefined) {
    patch.ai_custom_instructions = normalizeCustomInstructions(
      body.ai_custom_instructions
    );
  }

  if (body.whatsapp_instance_name !== undefined) {
    const raw =
      typeof body.whatsapp_instance_name === "string"
        ? body.whatsapp_instance_name.trim()
        : "";
    const instanceName = normalizeWhatsappInstanceName(raw);

    if (raw && !instanceName) {
      return NextResponse.json(
        {
          error:
            "Nome da instância inválido. Use letras, números, hífen, ponto ou sublinhado.",
        },
        { status: 400 }
      );
    }

    patch.whatsapp_instance_name = instanceName;
    // Nome novo (ou remoção) invalida o estado de conexão conhecido.
    patch.whatsapp_connected = false;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "Nenhum campo do atendente virtual foi informado." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("establishments")
    .update(patch)
    .eq("id", target.id)
    .select(CONFIG_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isSchemaError(error.message)) {
      return NextResponse.json(
        { error: MIGRATION_HINT, migration_pending: true },
        { status: 400 }
      );
    }
    if (/duplicate key|unique/i.test(error.message ?? "")) {
      return NextResponse.json(
        { error: "Esta instância do WhatsApp já está vinculada a outra loja." },
        { status: 409 }
      );
    }
    console.error("[whatsapp-ia] falha ao salvar a configuração:", error.message);
    return NextResponse.json(
      { error: "Falha ao salvar a configuração do atendente virtual." },
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      config: configForViewer(
        toWhatsappAiConfig(data as WhatsappAiConfigRow | null),
        target.isSuperAdmin
      ),
      meta: await panelMeta(),
      migration_pending: false,
    },
    { status: 200 }
  );
}

/** Ações de conexão aceitas pelo POST. */
interface WhatsappAiActionPayload {
  establishment_id?: unknown;
  action?: unknown;
  /** Nome da instância a usar/gravar (só Superadmin). */
  instance_name?: unknown;
}

/** Grava o último estado de conexão conhecido da loja (best-effort). */
async function persistConnectionState(
  establishmentId: string,
  connected: boolean
): Promise<void> {
  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from("establishments")
    .update({ whatsapp_connected: connected })
    .eq("id", establishmentId);

  if (error && !isSchemaError(error.message)) {
    console.error(
      "[whatsapp-ia] falha ao gravar o estado de conexão:",
      error.message
    );
  }
}

/**
 * POST /api/whatsapp-ia — ações de conexão do número.
 *
 * Body: { establishment_id (obrigatório),
 *         action: "connect" | "status" | "disconnect",
 *         instance_name? (opcional; **apenas Superadmin**) }
 *
 * **Dono da loja e Superadmin**: conectar/desconectar o número é operação do
 * estabelecimento (o guard garante que cada um só mexe na própria loja). O nome
 * da instância enviado por quem não é Superadmin é ignorado.
 *
 * - `connect`: garante o nome da instância (body → banco → `<prefixo>-<slug>`
 *   da configuração global), cria a instância (idempotente) e devolve o QR Code
 *   para o celular da loja ler em WhatsApp → Dispositivos conectados.
 * - `status`: consulta o estado atual e sincroniza `whatsapp_connected`.
 * - `disconnect`: encerra a sessão do número com
 *   `DELETE /instance/logout/{instanceName}` (nome no PATH, chave no header
 *   `apikey`, sem body) e grava `whatsapp_connected = false` — inclusive quando
 *   a Evolution responde 400 porque a sessão já havia caído. A instância
 *   continua existindo, então o `connect` seguinte já devolve um QR Code novo.
 *
 * Sem `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` a rota responde 400 com a
 * mensagem de configuração (nada é enviado a lugar nenhum).
 */
export async function POST(request: Request) {
  let body: WhatsappAiActionPayload;
  try {
    body = (await request.json()) as WhatsappAiActionPayload;
  } catch {
    return NextResponse.json(
      { error: "Corpo da requisição inválido (JSON esperado)." },
      { status: 400 }
    );
  }

  const target = await resolveRequestEstablishment(
    request,
    body.establishment_id
  );
  if ("response" in target) return target.response;

  const action =
    typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  if (action !== "connect" && action !== "status" && action !== "disconnect") {
    return NextResponse.json(
      { error: "Ação inválida. Use connect, status ou disconnect." },
      { status: 400 }
    );
  }

  const adminClient = createAdminClient();
  const { data: storeRow, error: storeError } = await adminClient
    .from("establishments")
    .select("id, slug, whatsapp_instance_name")
    .eq("id", target.id)
    .maybeSingle();

  if (storeError) {
    if (isSchemaError(storeError.message)) {
      return NextResponse.json(
        { error: MIGRATION_HINT, migration_pending: true },
        { status: 400 }
      );
    }
    console.error(
      "[whatsapp-ia] falha ao carregar a instância da loja:",
      storeError.message
    );
    return NextResponse.json(
      { error: "Falha ao carregar a instância de WhatsApp da loja." },
      { status: 400 }
    );
  }

  const store = storeRow as
    | { slug?: string | null; whatsapp_instance_name?: string | null }
    | null;

  // Só o Superadmin escolhe o nome da instância (recurso da plataforma): o
  // lojista sempre usa a instância já vinculada / derivada do prefixo global.
  const requestedInstance = target.isSuperAdmin
    ? normalizeWhatsappInstanceName(body.instance_name)
    : null;
  const storedInstance = normalizeWhatsappInstanceName(
    store?.whatsapp_instance_name
  );

  // Nome da instância: informado > já gravado > derivado do prefixo global.
  const globalAi = await getGlobalAiSettings();
  const derivedInstance = buildWhatsappInstanceName(
    globalAi.instancePrefix,
    store?.slug ?? target.id
  );
  const instanceName = requestedInstance ?? storedInstance ?? derivedInstance;

  if (!instanceName) {
    return NextResponse.json(
      {
        error:
          "Não foi possível definir o nome da instância da Evolution API para esta loja.",
      },
      { status: 400 }
    );
  }

  // Persiste o nome (e zera o estado de conexão) antes de falar com a Evolution,
  // para o webhook já resolver a loja pela instância recém-criada.
  if (instanceName !== storedInstance) {
    const { error: persistError } = await adminClient
      .from("establishments")
      .update({ whatsapp_instance_name: instanceName, whatsapp_connected: false })
      .eq("id", target.id);

    if (persistError) {
      if (isSchemaError(persistError.message)) {
        return NextResponse.json(
          { error: MIGRATION_HINT, migration_pending: true },
          { status: 400 }
        );
      }
      if (/duplicate key|unique/i.test(persistError.message ?? "")) {
        return NextResponse.json(
          {
            error: "Esta instância do WhatsApp já está vinculada a outra loja.",
          },
          { status: 409 }
        );
      }
      console.error(
        "[whatsapp-ia] falha ao gravar o nome da instância:",
        persistError.message
      );
      return NextResponse.json(
        { error: "Falha ao gravar o nome da instância da loja." },
        { status: 400 }
      );
    }
  }

  if (!isEvolutionConfigured()) {
    return NextResponse.json(
      {
        error:
          "Evolution API não configurada neste ambiente (EVOLUTION_API_URL/EVOLUTION_API_KEY).",
      },
      { status: 400 }
    );
  }

  if (action === "connect") {
    // 1) A instância precisa existir ANTES do /instance/connect: na Evolution v2
    //    uma instância nova responde 404 nesse endpoint. O create é idempotente
    //    (403/409 = "already exists"), então chamar sempre é seguro.
    const created = await createEvolutionInstance(instanceName);
    if (!created.ok) {
      return NextResponse.json(
        {
          error: created.error ?? "Falha ao criar a instância na Evolution API.",
          instance: instanceName,
        },
        { status: 502 }
      );
    }

    // 2) Instância existente → busca o QR Code (base64/pairing code).
    const qr = await fetchEvolutionQrCode(instanceName);
    const connection = await fetchEvolutionConnectionState(instanceName);

    if (!connection.error) {
      await persistConnectionState(target.id, connection.connected);
    }

    // O próprio create devolve `qrcode` em várias versões: usar como fallback
    // evita a tela vazia quando o /connect responde 404 logo após a criação.
    const base64 = qr.base64 ?? created.qrcode?.base64 ?? null;
    const code = qr.code ?? created.qrcode?.code ?? null;
    const pairingCode = qr.pairingCode ?? created.qrcode?.pairingCode ?? null;
    const hasQr = Boolean(base64 || code || pairingCode);
    // Sem QR mas com o número já conectado não é erro.
    const qrError = hasQr || connection.connected ? null : qr.error ?? null;

    return NextResponse.json(
      {
        action: "connect",
        instance: instanceName,
        already_exists: created.alreadyExists === true,
        // Contrato do painel (PainelWhatsappIa): `qr.base64` em data URI.
        qr: {
          base64,
          code,
          pairing_code: pairingCode,
        },
        // Alias achatado para integrações que esperam o base64 na raiz.
        qrcode: base64,
        qr_error: qrError,
        state: connection.state,
        connected: connection.connected,
        state_error: connection.error ?? null,
        meta: await panelMeta(),
      },
      { status: 200 }
    );
  }

  if (action === "disconnect") {
    const result = await disconnectEvolutionInstance(instanceName);

    if (!result.ok) {
      // Nada foi limpo no banco: a loja mantém o último estado conhecido, então
      // a resposta NÃO afirma `connected: false` (era o que deixava o painel e o
      // banco divergentes quando a Evolution recusava o logout).
      return NextResponse.json(
        {
          action: "disconnect",
          instance: instanceName,
          error: result.error ?? "Falha ao desconectar o WhatsApp.",
          meta: await panelMeta(),
        },
        { status: 502 }
      );
    }

    // Sessão encerrada (ou já estava): a loja para de receber/enviar até
    // reconectar e o próximo `connect` libera um QR Code novo. A instância é
    // mantida na Evolution — só o estado de sessão é limpo aqui.
    await persistConnectionState(target.id, false);

    return NextResponse.json(
      {
        action: "disconnect",
        instance: instanceName,
        connected: false,
        state: "close",
        already_disconnected: result.alreadyDisconnected === true,
        // `true` quando a instância órfã foi removida da Evolution.
        instance_deleted: result.deleted === true,
        message: result.alreadyDisconnected
          ? "O WhatsApp já estava desconectado."
          : "WhatsApp desconectado. Gere um novo QR Code para reconectar.",
        meta: await panelMeta(),
      },
      { status: 200 }
    );
  }

  const connection = await fetchEvolutionConnectionState(instanceName);
  if (!connection.error) {
    await persistConnectionState(target.id, connection.connected);
  }

  return NextResponse.json(
    {
      action: "status",
      instance: instanceName,
      state: connection.state,
      connected: connection.connected,
      state_error: connection.error ?? null,
      meta: await panelMeta(),
    },
    { status: connection.error ? 502 : 200 }
  );
}

