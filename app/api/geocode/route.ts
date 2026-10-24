import { NextResponse } from "next/server";
import { lookupCep } from "@/lib/cep";
import { formatCep, parseCep } from "@/lib/delivery";

/**
 * GET /api/geocode?cep=01310-100
 *
 * Consulta pública de CEP usada pelo painel (CEP da loja) e pelo checkout.
 * Não exige sessão e não grava nada. Retorna 404 quando o CEP não existe.
 */
export async function GET(request: Request) {
  const rawCep = new URL(request.url).searchParams.get("cep")?.trim() ?? "";
  const cep = parseCep(rawCep);

  if (!cep) {
    return NextResponse.json(
      { error: "CEP inválido. Informe os 8 dígitos." },
      { status: 400 }
    );
  }

  const address = await lookupCep(cep);
  if (!address) {
    return NextResponse.json(
      { error: "CEP não encontrado." },
      { status: 404 }
    );
  }

  return NextResponse.json(
    {
      cep,
      formatted_cep: formatCep(cep),
      address,
    },
    { status: 200 }
  );
}
