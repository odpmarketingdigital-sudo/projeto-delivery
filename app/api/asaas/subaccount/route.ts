/**
 * /api/asaas/subaccount — recebimento online no modelo Split (Asaas Subcontas).
 *
 * Etapa 1 da integração:
 *  - `POST` cria a subconta do estabelecimento no Asaas (POST /accounts) na
 *    primeira conexão e guarda `asaas_account_id`/`asaas_wallet_id` na tabela
 *    `establishments`; também salva a chave PIX de resgate, o snapshot dos
 *    dados e a preferência "Aceitar PIX Online no cardápio".
 *  - Em chamadas seguintes (subconta já existente) atualiza apenas os dados de
 *    recebimento locais — o Asaas NÃO expõe edição de dados cadastrais de
 *    subconta pela API (isso é feito no painel do Asaas).
 *  - `GET` devolve o estado atual para a tela de configurações.
 *
 * Segurança: sessão + resolução do estabelecimento via `menuGuard` (o mesmo
 * padrão das demais rotas do painel).
 */

import { NextResponse } from "next/server";
import {
  AsaasError,
  createAsaasSubaccount,
  describeAsaasEnvironment,
  describeAsaasFailure,
  ensureAsaasWebhook,
  findAsaasSubaccountByCpfCnpj,
} from "@/lib/asaas";
import {
  isAsaasCompanyType,
  validateAsaasSubaccountForm,
  type AsaasSubaccountForm,
} from "@/lib/asaasSubaccount";
import { revalidatePublicStore } from "@/lib/storeAvailability";
import { getAppUrl } from "@/lib/email/config";
import {
  canManageEstablishment,
  requireMenuAccess,
  resolveMenuEstablishment,
} from "@/lib/supabase/menuGuard";
import { createAdminClient } from "@/lib/supabase/server";

const DENIED =
  "Você não tem permissão para configurar o pagamento online desta loja.";

const MISSING_COLUMNS =
  "A configuração de pagamento online ainda não está disponível no banco. " +
  "Execute a migração 20261110000027_add_asaas_subaccount_to_establishments.sql " +
  "no Supabase.";

/** Colunas de recebimento online (migração 20261110000027). */
const RECEIVING_COLUMNS =
  "asaas_account_id, asaas_wallet_id, asaas_subaccount, pix_key, accept_pix_online";

interface SubaccountRow {
  id: string;
  slug: string | null;
  asaas_account_id: string | null;
  asaas_wallet_id: string | null;
}

interface SubaccountBody extends Partial<AsaasSubaccountForm> {
  establishment_id?: string;
}

/** Detecta erro de "coluna inexistente" (base sem a migração executada). */
function isMissingColumn(error: { message?: string | null } | null): boolean {
  const message = error?.message ?? "";
  return (
    /asaas_|pix_key|accept_pix_online/i.test(message) &&
    (/does not exist/i.test(message) || /could not find/i.test(message))
  );
}

/** Normaliza o body (campos desconhecidos/tipos errados) para o formulário. */
function toForm(body: SubaccountBody): AsaasSubaccountForm {
  const str = (value: unknown): string =>
    typeof value === "string" ? value : "";
  return {
    name: str(body.name),
    cpfCnpj: str(body.cpfCnpj),
    email: str(body.email),
    phone: str(body.phone),
    incomeValue: str(body.incomeValue),
    postalCode: str(body.postalCode),
    address: str(body.address),
    addressNumber: str(body.addressNumber),
    complement: str(body.complement),
    province: str(body.province),
    companyType: isAsaasCompanyType(body.companyType) ? body.companyType : "",
    birthDate: str(body.birthDate),
    pixKey: str(body.pixKey),
    acceptPixOnline: body.acceptPixOnline === true,
  };
}

/** GET — estado atual do recebimento online (para a tela de configurações). */
export async function GET(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  const requested = new URL(request.url).searchParams.get("establishment_id");
  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    requested
  );
  if ("response" in resolved) return resolved.response;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return NextResponse.json({ error: DENIED }, { status: 403 });
  }

  const adminClient = createAdminClient();
  const { data: rawData, error } = await adminClient
    .from("establishments")
    .select(RECEIVING_COLUMNS)
    .eq("id", resolved.id)
    .maybeSingle();

  if (error) {
    if (isMissingColumn(error)) {
      return NextResponse.json({ connected: false, asaas_account_id: null });
    }
    console.error("[asaas/subaccount] falha ao ler a loja", error);
    return NextResponse.json(
      { error: "Não foi possível carregar a configuração de pagamento." },
      { status: 500 }
    );
  }

  const data = rawData as {
    asaas_account_id?: string | null;
    asaas_wallet_id?: string | null;
    asaas_subaccount?: unknown;
    pix_key?: string | null;
    accept_pix_online?: boolean | null;
  } | null;

  return NextResponse.json({
    connected: Boolean(data?.asaas_account_id),
    asaas_account_id: data?.asaas_account_id ?? null,
    asaas_wallet_id: data?.asaas_wallet_id ?? null,
    asaas_subaccount: data?.asaas_subaccount ?? null,
    pix_key: data?.pix_key ?? null,
    accept_pix_online: data?.accept_pix_online === true,
  });
}

/** POST — cria/atualiza o recebimento online da loja. */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let body: SubaccountBody;
  try {
    body = (await request.json()) as SubaccountBody;
  } catch {
    return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  }

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    body.establishment_id ?? null
  );
  if ("response" in resolved) return resolved.response;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id
  );
  if (!allowed) {
    return NextResponse.json({ error: DENIED }, { status: 403 });
  }

  const validation = validateAsaasSubaccountForm(toForm(body));
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { profile, pixKey, acceptPixOnline, isCompany } = validation.data;

  const adminClient = createAdminClient();
  const { data: rawRow, error: readError } = await adminClient
    .from("establishments")
    .select(`id, slug, ${RECEIVING_COLUMNS}`)
    .eq("id", resolved.id)
    .maybeSingle();

  if (readError) {
    if (isMissingColumn(readError)) {
      return NextResponse.json({ error: MISSING_COLUMNS }, { status: 409 });
    }
    console.error("[asaas/subaccount] falha ao ler a loja", readError);
    return NextResponse.json(
      { error: "Não foi possível carregar a loja." },
      { status: 500 }
    );
  }

  const row = rawRow as SubaccountRow | null;
  if (!row) {
    return NextResponse.json(
      { error: "Estabelecimento não encontrado." },
      { status: 404 }
    );
  }

  let accountId = row.asaas_account_id;
  let walletId = row.asaas_wallet_id;
  /**
   * API key da subconta — devolvida pelo Asaas APENAS na criação
   * (`accessToken.apiKey`). É o que permite emitir a cobrança PIX dentro da
   * subconta na Etapa 2 (Split com a taxa da plataforma).
   */
  let subaccountApiKey: string | null = null;
  let notice: string | null = null;

  // 1) Primeira conexão: cria a subconta no Asaas.
  if (!accountId) {
    try {
      const account = await createAsaasSubaccount({
        name: profile.name,
        email: profile.email,
        cpfCnpj: profile.cpfCnpj,
        mobilePhone: profile.phone,
        incomeValue: profile.incomeValue,
        address: profile.address,
        addressNumber: profile.addressNumber,
        complement: profile.complement || undefined,
        province: profile.province,
        postalCode: profile.postalCode,
        companyType: isCompany ? profile.companyType ?? undefined : undefined,
        birthDate: isCompany ? undefined : profile.birthDate ?? undefined,
      });
      accountId = account.id;
      walletId = account.walletId ?? null;
      subaccountApiKey =
        account.accessToken?.apiKey?.trim() || account.apiKey?.trim() || null;
    } catch (error) {
      // Duplicidade: reaproveita a subconta já existente com o mesmo documento.
      const duplicate =
        error instanceof AsaasError &&
        /já existe|already exists|duplicad|cpfcnpj/i.test(error.message);
      if (duplicate) {
        const existing = await findAsaasSubaccountByCpfCnpj(
          profile.cpfCnpj
        ).catch(() => null);
        if (existing) {
          accountId = existing.id;
          walletId = existing.walletId ?? null;
          notice = "Subconta já existente no Asaas foi conectada a esta loja.";
        }
      }
      if (!accountId) {
        const failure = describeAsaasFailure(
          error,
          "Não foi possível conectar ao Asaas."
        );
        const environment = describeAsaasEnvironment();

        // Log com o corpo detalhado do Asaas: é o que revela se o 403 é API
        // key inválida, ambiente divergente (sandbox × produção) ou restrição
        // de permissão/IP na conta.
        console.error(
          "[asaas/subaccount] o Asaas recusou a criação da subconta",
          {
            status: failure.status,
            code: failure.code,
            environment: environment.label,
            base_url: environment.baseUrl,
            request: failure.context,
            details: failure.details,
          }
        );

        // A resposta devolve o mesmo diagnóstico para a tela de configurações
        // (a UI exibe `error`; o restante serve para inspeção via devtools).
        return NextResponse.json(
          {
            error: failure.message,
            code: failure.code,
            asaas_status: failure.context?.gateway_status ?? failure.status,
            asaas_environment: environment.environment,
            asaas_base_url: environment.baseUrl,
            asaas_request: failure.context,
            details: failure.details,
          },
          { status: failure.status }
        );
      }
    }
  } else {
    // O Asaas não expõe edição de dados cadastrais de subconta via API: aqui
    // atualizamos apenas o recebimento (chave PIX / PIX online / snapshot).
    notice =
      "Dados de recebimento atualizados. Alterações cadastrais da subconta devem ser feitas no painel do Asaas.";
  }

  const fields: Record<string, unknown> = {
    asaas_account_id: accountId,
    asaas_wallet_id: walletId,
    asaas_subaccount: profile,
    pix_key: pixKey,
    accept_pix_online: acceptPixOnline,
    // Só existe na primeira conexão; nas seguintes o Asaas não devolve a chave
    // (e ela já está gravada). Nunca sai desta rota para o navegador.
    ...(subaccountApiKey ? { asaas_api_key: subaccountApiKey } : {}),
  };

  let { error: updateError } = await adminClient
    .from("establishments")
    .update(fields)
    .eq("id", row.id);

  // Base sem a migração 20261110000028 (`asaas_api_key`): salva o restante e
  // avisa no log — o PIX online fica indisponível até a migração ser aplicada.
  if (updateError && /asaas_api_key/i.test(updateError.message ?? "")) {
    const legacyFields = { ...fields };
    delete legacyFields.asaas_api_key;
    ({ error: updateError } = await adminClient
      .from("establishments")
      .update(legacyFields)
      .eq("id", row.id));
    if (!updateError) {
      console.warn(
        "[asaas/subaccount] migração 20261110000028 pendente — API key da subconta não foi salva."
      );
    }
  }

  if (updateError) {
    if (isMissingColumn(updateError)) {
      return NextResponse.json({ error: MISSING_COLUMNS }, { status: 409 });
    }
    console.error("[asaas/subaccount] falha ao salvar", updateError);
    return NextResponse.json(
      {
        error:
          "A subconta foi processada, mas não foi possível salvar os dados no banco.",
      },
      { status: 500 }
    );
  }

  // A credencial da subconta nunca volta para o navegador (o `fields` é
  // devolvido no JSON de sucesso apenas para reabrir o formulário).
  delete fields.asaas_api_key;

  // Fecha o fluxo da Etapa 2: a subconta precisa enviar os eventos das
  // cobranças emitidas por ela para o endpoint da plataforma. Best-effort —
  // uma falha aqui não desfaz a conexão do recebimento online.
  let webhookApiKey = subaccountApiKey;
  if (!webhookApiKey) {
    // Subconta já conectada: reaproveita a credencial salva para garantir o
    // webhook (lojas conectadas antes da Etapa 2 não tinham esse registro).
    const { data: keyRow } = await adminClient
      .from("establishments")
      .select("asaas_api_key")
      .eq("id", row.id)
      .maybeSingle();
    const stored = (keyRow as { asaas_api_key?: string | null } | null)
      ?.asaas_api_key;
    webhookApiKey = stored?.trim() || null;
  }

  if (webhookApiKey) {
    try {
      await ensureAsaasWebhook(
        {
          url: `${getAppUrl()}/api/asaas/webhook`,
          email: profile.email,
          authToken: process.env.ASAAS_WEBHOOK_TOKEN?.trim() || undefined,
        },
        { apiKey: webhookApiKey }
      );
    } catch (error) {
      const failure = describeAsaasFailure(
        error,
        "Não foi possível registrar o webhook da subconta."
      );
      console.warn(
        "[asaas/subaccount] não foi possível registrar o webhook da subconta",
        {
          message: failure.message,
          code: failure.code,
          request: failure.context,
          details: failure.details,
        }
      );
    }
  }

  // Reflete a mudança de "Aceitar PIX Online" imediatamente no cardápio.
  revalidatePublicStore(row.slug);

  return NextResponse.json({
    establishment: fields,
    connected: Boolean(accountId),
    updated: Boolean(row.asaas_account_id),
    notice,
  });
}
