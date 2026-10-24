import { createAdminClient } from "./server";

const PRODUCTS_BUCKET = "products";

export async function deleteProductImageFromStorage(
  fileUrlOrName: string
): Promise<void> {
  console.log("----------------------------------------");
  console.log(" [DEBUG STORAGE] Função deleteProductImageFromStorage chamada!");
  console.log(" [DEBUG STORAGE] Valor bruto recebido:", JSON.stringify(fileUrlOrName));

  if (!fileUrlOrName || typeof fileUrlOrName !== "string") {
    console.log(" [DEBUG STORAGE] Operação cancelada: Caminho vazio ou inválido.");
    return;
  }

  const adminClient = createAdminClient();
  let filePath = fileUrlOrName.trim().split("?")[0].split("#")[0];

  const publicPrefix = `/storage/v1/object/public/${PRODUCTS_BUCKET}/`;
  const idx = filePath.indexOf(publicPrefix);
  
  if (idx !== -1) {
    filePath = filePath.slice(idx + publicPrefix.length);
    console.log(" [DEBUG STORAGE] Removido prefixo público da URL. Caminho ajustado:", filePath);
  } else if (filePath.startsWith(`${PRODUCTS_BUCKET}/`)) {
    filePath = filePath.slice(`${PRODUCTS_BUCKET}/`.length);
    console.log(" [DEBUG STORAGE] Removido prefixo do bucket. Caminho ajustado:", filePath);
  }

  const fileName = filePath.split("/").pop()?.trim();
  if (!fileName) {
    console.log(" [DEBUG STORAGE] Nome do ficheiro inválido após o parse.");
    return;
  }

  const pathToRemove = filePath.includes("/") ? filePath : fileName;
  console.log(" [DEBUG STORAGE] Caminho final exato que será enviado ao Supabase remove():", pathToRemove);

  try {
    const { data, error } = await adminClient.storage
      .from(PRODUCTS_BUCKET)
      .remove([pathToRemove]);

    if (error) {
      console.error(" [DEBUG STORAGE ERROR] Erro retornado pelo Supabase Storage:", error);
    } else {
      console.log(" [DEBUG STORAGE SUCCESS] Supabase executou o remove com sucesso. Resposta:", data);
    }
  } catch (err) {
    console.error(" [DEBUG STORAGE CATCH] Erro crítico na execução:", err);
  }
  console.log("----------------------------------------");
}