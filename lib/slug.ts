/**
 * Utilitários de slug (URLs amigáveis) para estabelecimentos.
 *
 * Módulo isomórfico (sem APIs de navegador/servidor): usado pelas rotas de API
 * para gerar o slug público no cadastro da loja. A normalização remove acentos
 * e caracteres não alfanuméricos, produzindo um slug em minúsculas separado
 * por hífens — o mesmo formato do backfill da migração `000006`.
 */

/**
 * Normaliza um texto em um slug URL-safe: minúsculas, sem acentos, espaços e
 * pontuação convertidos em hífens, sem hífens sobrando nas pontas.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Gera um slug único a partir de um nome. Se `base` (ou uma variação com sufixo
 * numérico) já existir segundo o predicado `exists`, acrescenta `-2`, `-3`...
 * até encontrar um slug livre. O tamanho é limitado para manter a URL curta.
 */
export async function generateUniqueSlug(
  name: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(name).slice(0, 60) || "loja";
  let candidate = base;
  let counter = 2;
  // Limitado para evitar loop infinito em bases com muitas colisões.
  while (counter < 1000 && (await exists(candidate))) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}
