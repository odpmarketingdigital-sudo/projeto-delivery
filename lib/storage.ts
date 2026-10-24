/**
 * Utilitários de persistência do perfil do cliente no navegador (localStorage).
 *
 * Objetivo: reconhecer clientes que já compraram e pré-preencher o checkout,
 * além de manter os dados de entrega atualizados a cada pedido — sem back-end.
 *
 * Todas as funções são seguras para SSR: quando `window` não existe
 * (renderização no servidor) ou o localStorage está indisponível, retornam
 * valores neutros em vez de lançar erros.
 */

/** Chave usada no localStorage para guardar o perfil do cliente. */
export const CUSTOMER_PROFILE_KEY = "fuego_customer_profile";

/** Dados do cliente salvos para pré-preenchimento do checkout. */
export interface CustomerProfile {
  name: string;
  phone: string; // WhatsApp
  /** CEP do endereço de entrega (somente dígitos, quando informado). */
  cep?: string;
  street: string;
  number: string;
  neighborhood: string;
  complement?: string;
}

/**
 * Lê o perfil do cliente do localStorage.
 * Retorna `null` quando não há dados salvos, o JSON está corrompido ou
 * estamos em ambiente sem `window` (SSR).
 */
export function getCustomerProfile(): CustomerProfile | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(CUSTOMER_PROFILE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<CustomerProfile> | null;
    if (!parsed || typeof parsed !== "object") return null;

    // Validação mínima dos campos obrigatórios.
    const { name, phone, cep, street, number, neighborhood, complement } = parsed;
    if (
      typeof name !== "string" ||
      typeof phone !== "string" ||
      typeof street !== "string" ||
      typeof number !== "string" ||
      typeof neighborhood !== "string"
    ) {
      return null;
    }

    return {
      name,
      phone,
      ...(typeof cep === "string" && cep ? { cep } : {}),
      street,
      number,
      neighborhood,
      complement: typeof complement === "string" ? complement : undefined,
    };
  } catch {
    // JSON inválido ou localStorage bloqueado (modo privado, etc.).
    return null;
  }
}

/**
 * Salva (ou atualiza) o perfil do cliente no localStorage.
 * Falhas de armazenamento são silenciadas para não interromper o checkout.
 */
export function saveCustomerProfile(profile: CustomerProfile): void {
  if (typeof window === "undefined") return;

  try {
    const payload: CustomerProfile = {
      name: profile.name,
      phone: profile.phone,
      ...(profile.cep ? { cep: profile.cep } : {}),
      street: profile.street,
      number: profile.number,
      neighborhood: profile.neighborhood,
      ...(profile.complement ? { complement: profile.complement } : {}),
    };
    window.localStorage.setItem(
      CUSTOMER_PROFILE_KEY,
      JSON.stringify(payload)
    );
  } catch {
    // Ignora erros de quota/permissão — o checkout segue funcionando.
  }
}

/** Remove o perfil do cliente do localStorage. */
export function clearCustomerProfile(): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(CUSTOMER_PROFILE_KEY);
  } catch {
    // Silencioso.
  }
}
