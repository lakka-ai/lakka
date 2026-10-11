import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';
import { sourceUrlFrom } from './source-url.ts';

/*
 * What this deployment is, for the AGPL notice (AD-6, AGPL section 13, ADR 0085): a link to the
 * source of the version running. It is read from the web container's environment when a page is
 * served, not baked in at build time, so an operator who changes the code and rebuilds, or
 * deploys a fork, points it at their own source with LAKKA_SOURCE_URL. Without it, the link
 * is the project repository at the revision the image was built from, when that is known.
 */

export interface About {
  sourceUrl: string;
  /** The address people reach this server at, as sign-in shows it: "ai.nordlys.se". */
  host: string;
}

/** The host a request came to, through Caddy; empty when it does not look like one. */
export function hostOf(forwarded: string | undefined, host: string | undefined): string {
  const raw = (forwarded ?? host ?? '').split(',')[0]?.trim() ?? '';
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(raw) ? raw : '';
}

export const getAbout = createServerFn({ method: 'GET' }).handler((): About => ({
  sourceUrl: sourceUrlFrom(process.env),
  host: hostOf(getRequestHeader('x-forwarded-host'), getRequestHeader('host')),
}));
