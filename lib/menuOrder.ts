import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Ordenação do cardápio tolerante a dados incompletos.
 *
 * O valor de ordenação pode vir de `position` (padrão do schema) ou de
 * `sort_order` (alias usado em algumas bases). Se ambos vierem vazios/nulos,
 * usamos `0` — evitando `NaN` na subtração, que desordenaria a lista. O empate
 * é resolvido por nome e, em último caso, por id, garantindo uma ordem estável
 * e determinística entre renderizações/recargas.
 *
 * Módulo isomórfico (sem APIs de navegador nem de servidor): é importado tanto
 * pelos Client Components do painel quanto pelas rotas de API.
 */

/** Forma mínima de um item ordenável do cardápio. */
export interface Orderable {
  id: string;
  name?: string;
  /** Coluna canônica de ordenação (schema atual). */
  position?: number | null;
  /** Alias alternativo de ordenação, quando a base usa `sort_order`. */
  sort_order?: number | null;
}

/**
 * Valor numérico de ordenação com fallback: `position` → `sort_order` → `0`.
 * Nunca retorna `NaN`, mesmo que a coluna venha vazia, nula ou como string.
 */
export function getOrderValue(
  item: Pick<Orderable, "position" | "sort_order">
): number {
  const raw = item.position ?? item.sort_order;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** Comparador estável (ordenação + desempate por nome e id). */
export function compareByOrder(a: Orderable, b: Orderable): number {
  const diff = getOrderValue(a) - getOrderValue(b);
  if (diff !== 0) return diff;

  const an = (a.name ?? "").toLowerCase();
  const bn = (b.name ?? "").toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Retorna uma nova lista ordenada pelo comparador do cardápio. */
export function sortByOrder<T extends Orderable>(items: readonly T[]): T[] {
  return [...items].sort(compareByOrder);
}

// ---------------------------------------------------------------------------
// Fallback de ordenação para as rotas de API (server-side).
// ---------------------------------------------------------------------------

/** Resultado mínimo de uma consulta Supabase usado pelo fallback. */
interface OrderQueryResult {
  data: unknown;
  error: PostgrestError | null;
}

/** Detecta erro de "coluna não existe" (Postgres 42703 / PostgREST). */
function isMissingColumnError(error: PostgrestError | null): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "42703" || code === "PGRST204") return true;
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return (
    message.includes("does not exist") || message.includes("undefined_column")
  );
}

/**
 * Executa uma consulta ordenada com "fallback em cadeia" para a coluna de
 * ordenação. Tenta `position`, depois `sort_order` e, por fim, `created_at`
 * (que sempre existe). Assim, se a base usar `sort_order` em vez de `position`
 * — ou a coluna estiver ausente — a consulta nunca quebra.
 *
 * `run` recebe a coluna primária de ordenação e deve montar a query já com o
 * critério de desempate (ex.: `.order(col).order("name")`).
 */
export async function fetchWithOrderFallback<T>(
  run: (orderColumn: string) => PromiseLike<OrderQueryResult>,
  dataMapper?: (data: unknown) => T[] | null
): Promise<{ data: T[] | null; error: PostgrestError | null }> {
  const candidates = ["position", "sort_order", "created_at"];
  let last: OrderQueryResult = { data: null, error: null };

  for (const column of candidates) {
    last = await run(column);
    if (!last.error) {
      return {
        data: dataMapper ? dataMapper(last.data) : (last.data as T[] | null),
        error: null,
      };
    }
    // Erro que não é de coluna ausente (ex.: RLS/rede): propaga sem insistir.
    if (!isMissingColumnError(last.error)) {
      return { data: null, error: last.error };
    }
  }

  return { data: null, error: last.error };
}
