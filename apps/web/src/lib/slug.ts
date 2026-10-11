/*
 * A workspace's name for links (its slug), made from the name people type, so nobody has to
 * choose one: first-run setup and Create workspace both use it (ADR 0102).
 */

/** The name for links from a workspace's name: "Product team" becomes "product-team". */
export function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // Accents come apart from their letters; drop them rather than make a dash of them.
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug === '' ? 'workspace' : slug;
}
