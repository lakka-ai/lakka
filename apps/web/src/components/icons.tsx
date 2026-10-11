import { useId } from 'react';
import type { ReactNode } from 'react';

/*
 * The stroke icons drawn on the design boards (docs/design/mockups), kept as inline SVG so the
 * app loads no icon font or library. Shared by the shell and the patterns. Every icon here is decorative: the text or aria-label next
 * to it names the control, so each one is aria-hidden.
 */

const paths = {
  chat: <path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5Z" />,
  spend: (
    <>
      <circle cx="15.3" cy="15.3" r="6.2" />
      <path d="M14.89 9.12A6.2 6.2 0 1 0 9.12 14.89" />
      <path d="M15.3 12.6v5.4" />
    </>
  ),
  requests: <path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.5M4 12h.5M4 17.5h.5" />,
  routing: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M6 8.5v7M8.3 7.2l7.4 3.6" />
    </>
  ),
  tools: (
    <path d="M14.5 4.5a4.5 4.5 0 0 0-5.3 6L4 15.7a2 2 0 0 0 2.8 2.8L12 13.3a4.5 4.5 0 0 0 6-5.3l-2.6 2.6-2.6-.6-.6-2.6Z" />
  ),
  connections: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  workspaces: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
  signIn: (
    <>
      <circle cx="8" cy="7.5" r="3" />
      <path d="M2.5 19c.8-3 3-4.5 5.5-4.5" />
      <circle cx="14" cy="16" r="3" />
      <path d="M16.2 13.8l5-5M19.2 10.8l1.6 1.6M17.6 12.4l1.4 1.4" />
    </>
  ),
  // The key is cut out of the cube by a mask, so the two never cross. Each drawing gets its own
  // mask id (the menu and the phone drawer can both be on one page).
  modelProviders: (id: string) => (
    <>
      <defs>
        <mask id={id}>
          <rect width="24" height="24" fill="#fff" />
          <circle cx="14" cy="16" r="3" fill="#000" stroke="#000" strokeWidth={4.75} />
          <path
            d="M16.2 13.8l5-5M19.2 10.8l1.6 1.6M17.6 12.4l1.4 1.4"
            stroke="#000"
            strokeWidth={4.75}
          />
        </mask>
      </defs>
      <path
        mask={`url(#${id})`}
        d="M10 2.5L16.5 6V13.5L10 17L3.5 13.5V6ZM3.5 6L10 9.5L16.5 6M10 9.5V17"
      />
      <circle cx="14" cy="16" r="3" />
      <path d="M16.2 13.8l5-5M19.2 10.8l1.6 1.6M17.6 12.4l1.4 1.4" />
    </>
  ),
  /** An API key, as on the tool approval notice for a request made with one. */
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
    </>
  ),
  instanceSpend: (
    <>
      <circle cx="15.5" cy="6" r="3.5" />
      <path d="M3 12.5v8" />
      <path d="M3 14h3.8l2.9-1.3c.8-.4 1.8-.3 2.5.3l.3.3c.6.6.3 1.6-.5 1.8L8.8 15.6" />
      <path d="M6.8 19h6.1c.8 0 1.6-.2 2.3-.7l4.9-3.3c.6-.4.8-1.2.3-1.8-.4-.6-1.2-.8-1.8-.4L14 15.3" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  retention: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  diagnostics: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  // Why this model (Pattern 1)
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  pin: <path d="M12 3.5v10M8 13.5h8M12 13.5V21" />,
  cheaper: (
    <>
      <path d="M4 6h8v8h8" />
      <path d="M16 10l4 4-4 4" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  // Notices, meters and state
  warning: (
    <>
      <path d="M12 3.5 2.8 19.5h18.4Z" />
      <path d="M12 10v4.5M12 17v.5" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16v.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.4" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  download: <path d="M12 4.5v11M7 11l5 5 5-5M5 19.5h14" />,
  /** Ask again: a circle turning back to where it started. */
  retry: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.9" />
      <path d="M4.5 4.5v4.4h4.4" />
    </>
  ),
  drop: <path d="M12 4.5v15M6 13.5l6 6 6-6" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  // Chat
  plus: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
  pencil: <path d="M5 19l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L9 18Z" />,
  play: <path d="M8 5.5v13l10.5-6.5Z" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M4 4l16 16" />
    </>
  ),
  paperclip: (
    <path d="M20 11.5 12.2 19.3a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.3" />
  ),
  send: <path d="M4 12h14M12 5l7 7-7 7" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
  file: (
    <>
      <path d="M7 3.5h7l4.5 4.5v12.5h-11.5Z" />
      <path d="M14 3.5V8h4.5" />
    </>
  ),
  // Lines of text: a model that reads text only.
  text: <path d="M5 7h14M5 12h14M5 17h9" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M20.5 16l-5-5-8 8" />
    </>
  ),
  chevronRight: <path d="M9 6l6 6-6 6" />,
  /** Stands in for chevronRight where there is nothing to open: the same stroke and width. */
  minus: <path d="M9 12h6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  upDown: <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />,
  /** The side menu's toggles: a panel with a filled left edge, and which way it will move. */
  menuCollapse: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M5.5 4.5H9v15H5.5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" fill="currentColor" />
      <path d="M15.5 10l-2 2 2 2" />
    </>
  ),
  menuExpand: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M5.5 4.5H9v15H5.5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z" fill="currentColor" />
      <path d="M13.5 10l2 2-2 2" />
    </>
  ),
  /** Chat's conversation list toggles: the same panel with an open left edge. */
  conversationsHide: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9 4.5v15M15.5 10l-2 2 2 2" />
    </>
  ),
  conversationsShow: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9 4.5v15M13.5 10l2 2-2 2" />
    </>
  ),
} satisfies Record<string, ReactNode | ((id: string) => ReactNode)>;

export type IconName = keyof typeof paths;

/** An icon, decorative: 16px, 18px below 1024px, unless the caller names a size. */
export function Icon({
  name,
  className = 'size-(--lk-icon)',
}: {
  name: IconName;
  className?: string;
}) {
  const id = useId();
  const drawing = paths[name];
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {typeof drawing === 'function' ? drawing(id) : drawing}
    </svg>
  );
}
