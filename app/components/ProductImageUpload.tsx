"use client";

import { useCallback, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { compressImageToWebP } from "@/lib/image-compression";

export interface ProductImageUploadProps {
  accept?: string;
  disabled?: boolean;
  onUpload?: (publicUrl: string, fileName: string) => void;
  onError?: (message: string) => void;
  children: ReactNode;
}

const BUCKET = "products";

function getPublicUrl(fileName: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${fileName}`;
}

async function uploadToStorage(file: File): Promise<string> {
  const supabase = createClient();
  const { error } = await supabase.storage.from(BUCKET).upload(file.name, file, {
    cacheControl: "3600",
    upsert: false,
  });
  if (error) {
    throw new Error(error.message ?? "Falha ao fazer upload da imagem.");
  }
  return getPublicUrl(file.name);
}

export function ProductImageUpload({
  accept = "image/*",
  disabled = false,
  onUpload,
  onError,
  children,
}: ProductImageUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        onError?.("Selecione um arquivo de imagem válido.");
        return;
      }

      setIsUploading(true);
      try {
        const compressedFile = await compressImageToWebP(file, {
          maxSizeMB: 0.5,
          maxWidthOrHeight: 1200,
          fileType: "image/webp",
          fileName: `produto-${Date.now()}`,
        });
        const publicUrl = await uploadToStorage(compressedFile);
        onUpload?.(publicUrl, compressedFile.name);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Erro inesperado ao enviar imagem.";
        onError?.(message);
      } finally {
        setIsUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [onError, onUpload]
  );

  const handleClick = useCallback(() => {
    if (disabled || isUploading) return;
    inputRef.current?.click();
  }, [disabled, isUploading]);

  return (
    <div
      role="button"
      tabIndex={disabled || isUploading ? -1 : 0}
      aria-busy={isUploading}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      className="cursor-pointer focus:outline-none"
    >
      {children}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled || isUploading}
        hidden
        onChange={handleChange}
      />
    </div>
  );
}
