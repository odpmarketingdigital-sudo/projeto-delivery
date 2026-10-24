/**
 * Utilitário de compressão e redimensionamento de imagens no front-end.
 *
 * Utiliza `browser-image-compression` para redimensionar (máximo 1200px no
 * maior lado) e compactar para WebP (~500 KB alvo) antes do upload para o
 * bucket `products` do Supabase Storage.
 */

import imageCompression from "browser-image-compression";

export interface CompressImageOptions {
  /** Tamanho máximo alvo em MB (padrão: 0.5 MB ≈ 500 KB). */
  maxSizeMB?: number;
  /** Largura ou altura máxima em px (padrão: 1200). */
  maxWidthOrHeight?: number;
  /** Tipo de arquivo de saída (padrão: image/webp). */
  fileType?: string;
  /** Nome base do arquivo de saída (sem extensão). */
  fileName?: string;
}

/**
 * Comprime e redimensiona um arquivo de imagem, retornando um novo `File`
 * no formato WebP com nome único (`produto-<timestamp>.webp` por padrão).
 * 
 * @param file Arquivo original selecionado pelo usuário.
 * @param options Opções de compressão.
 * @returns Arquivo comprimido pronto para upload.
 */
export async function compressImageToWebP(
  file: File,
  options: CompressImageOptions = {}
): Promise<File> {
  const {
    maxSizeMB = 0.5,
    maxWidthOrHeight = 1200,
    fileType = "image/webp",
    fileName = `produto-${Date.now()}`,
  } = options;

  const compressionOptions = {
    maxSizeMB,
    maxWidthOrHeight,
    useWebWorker: true,
    fileType,
    alwaysKeepResolution: false,
  };

  // O browser-image-compression retorna um File/Blob compactado
  const compressedFile = await imageCompression(file, compressionOptions);

  // Garantimos que o arquivo final tenha o nome correto e a extensão .webp
  const finalFileName = `${fileName.endsWith('.webp') ? fileName.replace(/\.[^/.]+$/, '') : fileName}.webp`;

  return new File([compressedFile], finalFileName, {
    type: fileType,
    lastModified: Date.now(),
  });
}