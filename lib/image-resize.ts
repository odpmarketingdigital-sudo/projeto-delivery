/**
 * Redimensionamento e recorte de imagens no navegador (Canvas API).
 *
 * Usado pelo upload da identidade visual do estabelecimento (logo e banner):
 * o arquivo escolhido é recortado em "cover" (centralizado, sem distorcer) na
 * proporção final e reencodado em WebP antes de subir para o Supabase Storage.
 *
 * Vantagens: previsibilidade visual (logo 1:1 e banner 3:1 sempre iguais em
 * todas as lojas) e payloads muito menores (WebP 85% costuma ficar abaixo de
 * 100 KB, contra megabytes de um JPG/PNG de celular).
 *
 * O módulo é 100% client-side (`document`/`canvas`) — nunca importe em rotas de
 * API ou componentes de servidor.
 */

/** Qualidade padrão da codificação WebP (0–1). */
export const WEBP_QUALITY = 0.85;

/** Formato de saída padrão (WebP tem suporte de codificação em todos os browsers atuais). */
export const WEBP_MIME_TYPE = "image/webp";

/** Dimensões finais (e proporção) de cada tipo de imagem. */
export interface ImagePreset {
  /** Largura final em pixels. */
  width: number;
  /** Altura final em pixels. */
  height: number;
  /** Qualidade de codificação 0–1 (padrão: {@link WEBP_QUALITY}). */
  quality?: number;
}

/** Logo do estabelecimento: quadrada, 1:1, 500 × 500 px. */
export const LOGO_IMAGE_PRESET: ImagePreset = {
  width: 500,
  height: 500,
  quality: WEBP_QUALITY,
};

/** Banner/capa da loja: 3:1, 1200 × 400 px. */
export const BANNER_IMAGE_PRESET: ImagePreset = {
  width: 1200,
  height: 400,
  quality: WEBP_QUALITY,
};

/** Opções de {@link resizeAndCropToWebP}. */
export interface ResizeImageOptions extends ImagePreset {
  /**
   * Nome base do arquivo de saída (sem extensão). Um sufixo `-<timestamp>` é
   * acrescentado para evitar colisões no bucket. Padrão: `imagem`.
   */
  fileName?: string;
  /** Tipo de saída (padrão: `image/webp`). */
  mimeType?: string;
}

/** Resultado do processamento — pronto para pré-visualização e upload. */
export interface ResizedImage {
  /** Arquivo final (nome com extensão do formato gerado). */
  file: File;
  /** Mesmo conteúdo de `file`, útil para montar object URLs de prévia. */
  blob: Blob;
  /** Largura final em pixels (sempre igual a `preset.width`). */
  width: number;
  /** Altura final em pixels (sempre igual a `preset.height`). */
  height: number;
  /** Largura da imagem original (para feedback ao lojista). */
  originalWidth: number;
  /** Altura da imagem original (para feedback ao lojista). */
  originalHeight: number;
  /** MIME realmente gravado (pode ser `image/jpeg` em browsers sem WebP). */
  mimeType: string;
  /** Qualidade usada na codificação. */
  quality: number;
}

/** Extensão de arquivo correspondente a cada MIME suportado na saída. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

interface LoadedSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Libera os recursos (bitmap fechado ou object URL revogada). */
  cleanup: () => void;
}

/**
 * Decodifica o arquivo em algo desenhável no canvas.
 *
 * Prefere `createImageBitmap` (decodificação fora da main thread e já respeita
 * a orientação EXIF em navegadores atuais) e cai para `<img>` + object URL em
 * ambientes sem suporte.
 */
async function loadSource(file: File): Promise<LoadedSource> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Formato não decodificável pelo createImageBitmap: tenta via <img>.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.decoding = "async";
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(
          new Error(
            "Não foi possível ler a imagem. Tente outro arquivo PNG, JPG ou WebP."
          )
        );
      element.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

interface CropRect {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Calcula o recorte central ("object-fit: cover") para a proporção alvo:
 * a imagem é cortada nas laterais (ou no topo/base) sem distorção.
 */
function computeCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): CropRect {
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;

  if (sourceRatio > targetRatio) {
    // Mais larga que o alvo: corta as laterais.
    const croppedWidth = Math.max(1, Math.round(sourceHeight * targetRatio));
    return {
      sourceX: Math.max(0, Math.round((sourceWidth - croppedWidth) / 2)),
      sourceY: 0,
      sourceWidth: croppedWidth,
      sourceHeight,
    };
  }

  // Mais alta que o alvo: corta topo/base.
  const croppedHeight = Math.max(1, Math.round(sourceWidth / targetRatio));
  return {
    sourceX: 0,
    sourceY: Math.max(0, Math.round((sourceHeight - croppedHeight) / 2)),
    sourceWidth,
    sourceHeight: croppedHeight,
  };
}

/** `canvas.toBlob` em Promise, com mensagem de erro amigável. */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Não foi possível converter a imagem."));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Redimensiona (recorte central) e converte a imagem para WebP.
 *
 * - Saída sempre com exatamente `width × height` (ex.: 500×500, 1200×400);
 * - Qualidade padrão 85%;
 * - Se o navegador não souber **codificar** WebP (Safari antigo), cai para
 *   JPEG com a mesma qualidade — o nome/extensão do arquivo acompanha o MIME
 *   realmente gerado, evitando um `File` inconsistente no Storage;
 * - Erros são lançados com mensagens em pt-BR prontas para a interface.
 */
export async function resizeAndCropToWebP(
  file: File,
  options: ResizeImageOptions
): Promise<ResizedImage> {
  const {
    width,
    height,
    quality = WEBP_QUALITY,
    fileName = "imagem",
    mimeType = WEBP_MIME_TYPE,
  } = options;

  if (!width || !height) {
    throw new Error("Dimensões de destino inválidas para o processamento.");
  }

  const loaded = await loadSource(file);

  try {
    const { source, width: sourceWidth, height: sourceHeight } = loaded;
    if (!sourceWidth || !sourceHeight) {
      throw new Error("A imagem selecionada não possui dimensões válidas.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Seu navegador não suporta o processamento de imagens.");
    }

    // Qualidade do downscale (evita serrilhado ao reduzir bastante o tamanho).
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    const crop = computeCoverCrop(sourceWidth, sourceHeight, width, height);
    context.drawImage(
      source,
      crop.sourceX,
      crop.sourceY,
      crop.sourceWidth,
      crop.sourceHeight,
      0,
      0,
      width,
      height
    );

    let blob = await canvasToBlob(canvas, mimeType, quality);

    // Browser sem encoder do formato pedido devolve outro MIME (normalmente
    // PNG, bem mais pesado): recodifica em JPEG na mesma qualidade.
    if (mimeType !== "image/png" && blob.type !== mimeType) {
      blob = await canvasToBlob(canvas, "image/jpeg", quality);
    }

    const outputMime = blob.type || mimeType;
    const extension = EXTENSION_BY_MIME[outputMime] ?? "webp";
    const baseName = fileName.replace(/\.[^./\\]+$/, "") || "imagem";
    const outputName = `${baseName}-${Date.now()}.${extension}`;

    const outputFile = new File([blob], outputName, {
      type: outputMime,
      lastModified: Date.now(),
    });

    return {
      file: outputFile,
      blob,
      width,
      height,
      originalWidth: sourceWidth,
      originalHeight: sourceHeight,
      mimeType: outputMime,
      quality,
    };
  } finally {
    loaded.cleanup();
  }
}
