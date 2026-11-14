import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type {
  ImportedMenu,
  ImportedMenuCategory,
  ImportedMenuProduct,
} from "@/lib/types";

/** Modelo multimodal padrão usado na extração (sobrescrevível por env). */
export const DEFAULT_MENU_IMPORT_MODEL = "gemini-3.8-flash";

/** Tamanho máximo aceito no upload (10 MB). */
export const MENU_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** Tipos MIME aceitos (PDF e imagens comuns de cardápio). */
export const MENU_IMPORT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;

export type MenuImportMimeType = (typeof MENU_IMPORT_MIME_TYPES)[number];

/** Limites de sanidade para não estourar o payload/insert em lote. */
const MAX_CATEGORIES = 60;
const MAX_PRODUCTS_PER_CATEGORY = 200;
const MAX_TOTAL_PRODUCTS = 600;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Instruções para o Gemini: extração fiel, sem inventar itens, preços apenas
 * numéricos e agrupamento pelas seções originais do cardápio.
 */
const MENU_IMPORT_PROMPT = `Você é um assistente especializado em digitalizar cardápios de restaurantes brasileiros.

Analise o arquivo enviado (PDF ou imagem) e extraia TODOS os itens do cardápio, seguindo as regras:
- Agrupe os produtos nas categorias/seções originais do cardápio (ex.: Lanches, Bebidas, Sobremesas). Se o cardápio não tiver seções explícitas, use uma única categoria chamada "Cardápio".
- Preserve os nomes dos produtos exatamente como aparecem no arquivo. Não invente, não traduza e não repita itens.
- "description": use o texto descritivo que acompanha o item; se não houver, use string vazia.
- "price": informe apenas o número em reais, sem "R$", sem separador de milhar e com ponto como separador decimal (ex.: 29.90). Se o preço estiver ausente ou ilegível, use 0.
- Ignore cabeçalhos, endereço, telefone, redes sociais, textos promocionais, formas de pagamento e qualquer informação que não seja categoria/produto.
- Se o arquivo não contiver um cardápio legível, retorne { "categories": [] }.

Responda SOMENTE com o JSON estruturado solicitado, sem comentários ou texto adicional.`;

/** JSON Schema do Structured Output do Gemini (respostas 100% tipadas). */
const MENU_IMPORT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    categories: {
      type: Type.ARRAY,
      description:
        "Categorias/seções do cardápio, na ordem em que aparecem no arquivo.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: {
            type: Type.STRING,
            description: "Nome da categoria exatamente como no cardápio.",
          },
          products: {
            type: Type.ARRAY,
            description: "Produtos que pertencem a esta categoria.",
            items: {
              type: Type.OBJECT,
              properties: {
                name: {
                  type: Type.STRING,
                  description: "Nome do produto exatamente como no cardápio.",
                },
                description: {
                  type: Type.STRING,
                  description:
                    "Descrição do produto; string vazia quando não houver.",
                },
                price: {
                  type: Type.NUMBER,
                  description:
                    "Preço em reais, apenas o número (ex.: 29.90); 0 se ausente/ilegível.",
                },
              },
              required: ["name", "description", "price"],
              propertyOrdering: ["name", "description", "price"],
            },
          },
        },
        required: ["name", "products"],
        propertyOrdering: ["name", "products"],
      },
    },
  },
  required: ["categories"],
  propertyOrdering: ["categories"],
};

/** Erro com status HTTP e código estável para as rotas de importação. */
export class MenuImportError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MenuImportError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Resolve o MIME do arquivo aceitando também arquivos sem `type` (comum em
 * mobile), caindo para a extensão do nome.
 */
export function resolveMenuFileMimeType(
  file: File,
): MenuImportMimeType | null {
  const type = file.type.toLowerCase();
  if ((MENU_IMPORT_MIME_TYPES as readonly string[]).includes(type)) {
    return type as MenuImportMimeType;
  }
  if (type === "image/jpg") {
    return "image/jpeg";
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    default:
      return null;
  }
}

/** Normaliza nomes para comparar categorias já existentes (case-insensitive). */
export function normalizeMenuName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Converte o preço da IA (number ou string como "R$ 29,90") em número.
 * Valores inválidos viram 0 para não bloquear a revisão no painel.
 */
function parsePrice(value: unknown): number {
  let parsed: number;

  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    let cleaned = value.replace(/[^\d,.-]/g, "").trim();
    if (!cleaned) {
      return 0;
    }
    if (cleaned.includes(",")) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    }
    parsed = Number(cleaned);
  } else {
    return 0;
  }

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.round(parsed * 100) / 100;
}

/**
 * Valida/normaliza a resposta da IA (ou o corpo da rota de save), garantindo:
 * nomes sem espaços duplicados, preços numéricos, categorias únicas e limites
 * de tamanho compatíveis com o insert em lote.
 */
export function sanitizeImportedMenu(raw: unknown): ImportedMenu {
  const source =
    raw && typeof raw === "object"
      ? (raw as { categories?: unknown })
      : { categories: [] };

  const rawCategories = Array.isArray(source.categories)
    ? source.categories
    : [];

  const categories = new Map<string, ImportedMenuCategory>();
  let totalProducts = 0;

  for (const rawCategory of rawCategories) {
    if (categories.size >= MAX_CATEGORIES || totalProducts >= MAX_TOTAL_PRODUCTS) {
      break;
    }
    if (!rawCategory || typeof rawCategory !== "object") {
      continue;
    }

    const category = rawCategory as { name?: unknown; products?: unknown };
    const name = cleanText(category.name, MAX_NAME_LENGTH);
    if (!name) {
      continue;
    }

    const key = normalizeMenuName(name);
    let target = categories.get(key);
    if (!target) {
      if (categories.size >= MAX_CATEGORIES) {
        break;
      }
      target = { name, products: [] };
      categories.set(key, target);
    }

    const rawProducts = Array.isArray(category.products)
      ? category.products
      : [];

    for (const rawProduct of rawProducts) {
      if (
        target.products.length >= MAX_PRODUCTS_PER_CATEGORY ||
        totalProducts >= MAX_TOTAL_PRODUCTS
      ) {
        break;
      }
      if (!rawProduct || typeof rawProduct !== "object") {
        continue;
      }

      const product = rawProduct as {
        name?: unknown;
        description?: unknown;
        price?: unknown;
      };
      const productName = cleanText(product.name, MAX_NAME_LENGTH);
      if (!productName) {
        continue;
      }

      const item: ImportedMenuProduct = {
        name: productName,
        description: cleanText(product.description, MAX_DESCRIPTION_LENGTH),
        price: parsePrice(product.price),
      };

      target.products.push(item);
      totalProducts += 1;
    }
  }

  return {
    categories: [...categories.values()].filter(
      (category) => category.products.length > 0,
    ),
  };
}

/**
 * Converte erros do SDK/HTTP do Gemini em `MenuImportError` com mensagens
 * amigáveis (arquivo ilegível, chave inválida, limite de uso etc.).
 */
function normalizeApiError(error: unknown): MenuImportError {
  if (error instanceof MenuImportError) {
    return error;
  }

  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();

  if (status === 429 || normalized.includes("resource_exhausted")) {
    return new MenuImportError(
      429,
      "ai_rate_limited",
      "O limite de uso da IA foi atingido. Aguarde alguns instantes e tente novamente.",
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    normalized.includes("api key") ||
    normalized.includes("unauthenticated")
  ) {
    return new MenuImportError(
      502,
      "ai_auth_failed",
      "A chave da API Gemini foi recusada pelo servidor. Verifique a variável GEMINI_API_KEY.",
    );
  }
  if (
    status === 400 ||
    normalized.includes("invalid_argument") ||
    normalized.includes("unable to process") ||
    normalized.includes("unsupported")
  ) {
    return new MenuImportError(
      422,
      "unreadable_file",
      "Não foi possível interpretar o arquivo. Verifique se o PDF/imagem está legível, sem senha, e tente novamente.",
    );
  }

  return new MenuImportError(
    502,
    "ai_request_failed",
    "Não foi possível consultar a IA agora. Tente novamente em instantes.",
  );
}

/**
 * Envia o arquivo ao Gemini com Structured Output e devolve o cardápio
 * sanitizado. Lança `MenuImportError` quando a chave não existe, o arquivo é
 * ilegível/corrompido ou a IA não encontra produtos.
 */
export async function extractMenuFromFile(
  file: File,
  mimeType: MenuImportMimeType,
): Promise<ImportedMenu> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new MenuImportError(
      500,
      "missing_api_key",
      "A variável de ambiente GEMINI_API_KEY não está configurada no servidor.",
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    throw new MenuImportError(
      400,
      "empty_file",
      "O arquivo enviado está vazio.",
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MENU_IMPORT_MODEL;

  const response = await ai.models
    .generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: MENU_IMPORT_PROMPT },
            { inlineData: { mimeType, data: bytes.toString("base64") } },
          ],
        },
      ],
      config: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: MENU_IMPORT_SCHEMA,
      },
    })
    .catch((error: unknown) => {
      throw normalizeApiError(error);
    });

  const text = response.text?.trim();
  if (!text) {
    throw new MenuImportError(
      422,
      "unreadable_file",
      "Não foi possível ler o cardápio no arquivo enviado. Verifique se a imagem/PDF está legível e tente novamente.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MenuImportError(
      422,
      "invalid_ai_response",
      "A IA retornou um formato inesperado. Tente novamente com outro arquivo.",
    );
  }

  const menu = sanitizeImportedMenu(parsed);
  if (menu.categories.length === 0) {
    throw new MenuImportError(
      422,
      "no_items_found",
      "Nenhum produto de cardápio foi identificado no arquivo. Verifique se a imagem/PDF está legível e tente novamente.",
    );
  }

  return menu;
}

