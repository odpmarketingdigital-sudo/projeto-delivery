import { NextResponse } from "next/server";
import {
  extractMenuFromFile,
  MenuImportError,
  MENU_IMPORT_MAX_BYTES,
  resolveMenuFileMimeType,
} from "@/lib/ai/menuImport";
import {
  canManageEstablishment,
  resolveMenuEstablishment,
  requireMenuAccess,
} from "@/lib/supabase/menuGuard";

/**
 * A chamada ao Gemini pode levar dezenas de segundos em PDFs grandes; este
 * limite evita que a função seja interrompida antes da resposta (Vercel/Next).
 */
export const maxDuration = 60;

/**
 * POST /api/ai/import-menu
 *
 * Recebe um PDF/imagem do cardápio via `multipart/form-data` (campo `file`),
 * valida tipo/tamanho, envia ao Gemini (Structured Output) e devolve as
 * categorias/produtos extraídos para revisão no painel — nada é gravado aqui.
 *
 * Um `admin` pode enviar apenas o próprio cardápio; `super_admin` precisa
 * informar `establishment_id` (mesmo padrão de `/api/products`).
 */
export async function POST(request: Request) {
  const guard = await requireMenuAccess();
  if (!guard.ok) return guard.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      {
        error:
          "Envie o cardápio como multipart/form-data com o arquivo no campo `file`.",
      },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Selecione um arquivo de cardápio (PDF, PNG ou JPG)." },
      { status: 400 },
    );
  }

  const requestedIdValue = form.get("establishment_id");
  const requestedId =
    typeof requestedIdValue === "string" ? requestedIdValue.trim() : null;

  const resolved = await resolveMenuEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    requestedId,
  );
  if ("response" in resolved) return resolved.response;

  const allowed = await canManageEstablishment(
    guard.user.id,
    guard.isSuperAdmin,
    resolved.id,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Você não tem acesso ao cardápio deste estabelecimento." },
      { status: 403 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { error: "O arquivo enviado está vazio." },
      { status: 400 },
    );
  }
  if (file.size > MENU_IMPORT_MAX_BYTES) {
    return NextResponse.json(
      {
        error:
          "O arquivo é muito grande. Envie um PDF ou imagem de até 10 MB.",
      },
      { status: 413 },
    );
  }

  const mimeType = resolveMenuFileMimeType(file);
  if (!mimeType) {
    return NextResponse.json(
      { error: "Formato não suportado. Envie um PDF, PNG ou JPG." },
      { status: 415 },
    );
  }

  try {
    const menu = await extractMenuFromFile(file, mimeType);
    return NextResponse.json(
      { menu, establishment_id: resolved.id },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof MenuImportError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }

    console.error("[ai/import-menu] erro inesperado:", error);
    return NextResponse.json(
      { error: "Erro inesperado ao analisar o cardápio. Tente novamente." },
      { status: 500 },
    );
  }
}
