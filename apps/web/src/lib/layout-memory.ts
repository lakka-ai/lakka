import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/react-start/server';

/*
 * Whether the desktop menu is collapsed to its rail and whether chat's conversation list is
 * hidden (docs/design/docs/screens.md, App shell; ADR 0107). Remembered per browser and applied
 * on every page. First-party cookies rather than browser storage, as for the workspace used
 * last, because the server renders the menu too: a page never paints wide and then jumps. Only
 * the collapsed state is stored; no cookie means the full layout.
 */

export interface Layout {
  /** The menu is the 64px rail. */
  rail: boolean;
  /** Chat's conversation list is hidden. */
  conversationsHidden: boolean;
}

const NAV = 'lk_nav';
const CONVERSATIONS = 'lk_conversations';

export function layoutFromCookie(header: string | undefined): Layout {
  const layout: Layout = { rail: false, conversationsHidden: false };
  for (const part of (header ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === NAV && value === 'rail') layout.rail = true;
    if (name === CONVERSATIONS && value === 'hidden') layout.conversationsHidden = true;
  }
  return layout;
}

export const rememberedLayout = createIsomorphicFn()
  .server(() => layoutFromCookie(getRequestHeader('cookie')))
  .client(() => layoutFromCookie(document.cookie));

function write(name: string, value: string | null): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    value === null
      ? `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
      : `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export function rememberRail(rail: boolean): void {
  write(NAV, rail ? 'rail' : null);
}

export function rememberConversationsHidden(hidden: boolean): void {
  write(CONVERSATIONS, hidden ? 'hidden' : null);
}
