import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

/*
 * The workspace a person used last, so the menu keeps showing it on pages whose address names
 * no workspace (the admin pages) and `/` can open it. A first-party cookie rather than browser
 * storage, because the server renders the menu too. It holds only an id; whether the person
 * may still see that workspace is checked against their workspace list every time.
 */

const COOKIE = 'lk_workspace';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workspaceFromCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE && value !== undefined && UUID.test(value)) return value;
  }
  return undefined;
}

export const rememberedWorkspace = createIsomorphicFn()
  .server(() => workspaceFromCookie(getRequestHeader('cookie')))
  .client(() => workspaceFromCookie(document.cookie));

export function rememberWorkspace(id: string): void {
  if (!UUID.test(id) || workspaceFromCookie(document.cookie) === id) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
