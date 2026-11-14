import { NextResponse } from "next/server";
import { geocodeStoreAddress, lookupCep } from "@/lib/cep";
import { formatCep, parseCep } from "@/lib/delivery";

/**
 * GET /api/geocode?cep=01310-100
 * GET /api/geocode?address=Av. Bady Bassitt, 1500 - Centro, São José do Rio Preto - SP
 *
 * Consulta pública de endereços usada pelo painel (origem do frete) e pelo
 * checkout. Não exige sessão e não grava nada.
 *
 *  - `cep`: resolve endereço + coordenadas a partir dos 8 dígitos;
 *  - `address`: geocodifica o texto livre digitado — é o que permite fixar a
 *    origem do frete na coordenada exata da loja (rua + número), em vez do
 *    centroide genérico de um CEP longo.
 *
 * Retorna 404 quando o CEP/endereço não existe ou não é localizado.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const rawAddress = params.get("address")?.trim() ?? "";

  if (rawAddress) {
    const place = await geocodeStoreAddress(rawAddress);
    if (!place) {
      return NextResponse.json(
        {
          error:
            "Não localizamos esse endereço. Confira rua, número, bairro e cidade.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        query: rawAddress,
        formatted_address: place.label,
        address: {
          street: place.street,
          neighborhood: place.neighborhood,
          city: place.city,
          state: place.state,
          cep: place.cep,
          latitude: place.latitude,
          longitude: place.longitude,
          source: "nominatim",
        },
      },
      { status: 200 }
    );
  }

  const rawCep = params.get("cep")?.trim() ?? "";
  const cep = parseCep(rawCep);

  if (!cep) {
    return NextResponse.json(
      {
        error:
          "Informe o CEP (8 dígitos) ou o endereço completo da loja para consultar.",
      },
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

  const cityState = [address.city, address.state]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("/");
  const formattedAddress = [
    address.street,
    address.neighborhood,
    cityState,
    `CEP ${formatCep(cep)}`,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");

  return NextResponse.json(
    {
      cep,
      formatted_cep: formatCep(cep),
      formatted_address: formattedAddress,
      address,
    },
    { status: 200 }
  );
}
