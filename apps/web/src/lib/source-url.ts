/*
 * The AGPL source link from the environment (AD-6, ADR 0085). Pure, so it is tested without a
 * server; lib/about.ts serves it.
 */

export const PROJECT_REPOSITORY = 'https://github.com/lakka-ai/lakka';

/** The source link from the environment; pure, so it can be tested without a server. */
export function sourceUrlFrom(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['LAKKA_SOURCE_URL']?.trim() ?? '';
  if (configured !== '' && URL.canParse(configured)) {
    const url = new URL(configured);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  }
  const revision = env['LAKKA_REVISION']?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/.test(revision)
    ? `${PROJECT_REPOSITORY}/tree/${revision}`
    : PROJECT_REPOSITORY;
}
