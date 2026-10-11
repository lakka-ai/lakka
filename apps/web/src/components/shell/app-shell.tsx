import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Drawer } from '@heroui/react';
import type { Principal, WorkspaceView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { rememberConversationsHidden, rememberRail } from '../../lib/layout-memory.ts';
import type { Layout } from '../../lib/layout-memory.ts';
import { AccountMenu } from './account-menu.tsx';
import { Brand } from './brand.tsx';
import { Icon } from '../icons.tsx';
import { NavList } from './nav-list.tsx';
import type { NavKey, NavModel } from './nav.ts';
import { RailTooltip } from './rail-tooltip.tsx';
import { WorkspaceSwitcher } from './workspace-switcher.tsx';

/*
 * The frame around every signed-in page (docs/design/docs/screens.md, App shell;
 * docs/design/docs/phone.md).
 *
 * - From 1024px: a 232px side menu. Brand and Collapse menu, workspace switcher, the main menu
 *   and the account. Collapsed, it is a 64px rail of icons with the same items at the same
 *   heights (ADR 0107). Below 1024px the side menu leaves too little room for the tables, so
 *   the phone layout takes over.
 * - Phone: a top bar with Menu, the page name and the workspace, and a drawer with the same
 *   menu.
 *
 * The AGPL notice is in the account menu (ADR 0107). The layouts are switched with CSS, so the
 * hidden one is display: none and out of the accessibility tree; there is only ever one main
 * menu to find.
 */

const MENU_ID = 'main-menu';
const MENU_TOGGLE = 'main-menu-toggle';
/** Chat's conversation list, and the buttons that hide it and show it again. */
export const CONVERSATIONS_ID = 'conversation-list';
export const CONVERSATIONS_HIDE = 'conversation-list-hide';
export const CONVERSATIONS_SHOW = 'conversation-list-show';

export interface ShellProps {
  me: Pick<Principal, 'displayName' | 'isInstanceAdmin'> & { email: string | null };
  workspaces: readonly WorkspaceView[];
  current: WorkspaceView | null;
  model: NavModel;
  currentKey: NavKey | undefined;
  /** The page name for the phone top bar. */
  title: string;
  sourceUrl: string;
  /** Whether the menu and chat's conversations start collapsed, from the browser's cookies. */
  layout: Layout;
  children: ReactNode;
}

function SideMenu({
  me,
  workspaces,
  current,
  model,
  currentKey,
  sourceUrl,
  rail,
  onToggle,
}: ShellProps & { rail: boolean; onToggle: () => void }) {
  const toggleLabel = rail ? t('nav.expand') : t('nav.collapse');
  const toggle = (
    <RailTooltip label={toggleLabel}>
      <Button
        id={MENU_TOGGLE}
        isIconOnly
        variant="ghost"
        aria-label={toggleLabel}
        aria-expanded={!rail}
        aria-controls={MENU_ID}
        // In the rail every item is 40px wide, 12px from either edge (ADR 0107); the button
        // keeps its md height, so nothing moves up or down when the menu collapses.
        className={`text-muted ${rail ? 'w-10' : ''}`}
        onPress={onToggle}
      >
        <Icon name={rail ? 'menuExpand' : 'menuCollapse'} />
      </Button>
    </RailTooltip>
  );
  return (
    <div
      id={MENU_ID}
      className={`sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-secondary pt-4 pb-3 *:shrink-0 lg:flex ${
        // Nothing in it shrinks (*:shrink-0): in a short window the menu scrolls rather than
        // squash the workspace switcher and the account button below their 48px. The rail's
        // 64px are inside its border, so its 40px items keep the full menu's 12px to either side.
        rail ? 'w-(--lk-rail-width) items-center' : 'w-(--lk-menu-width) px-3'
      }`}
    >
      {rail ? (
        toggle
      ) : (
        <div className="flex h-8 items-center justify-between pl-2.5">
          <Brand />
          {toggle}
        </div>
      )}
      {current !== null && (
        <WorkspaceSwitcher
          me={me}
          workspaces={workspaces}
          current={current}
          currentKey={currentKey}
          variant={rail ? 'rail' : 'side'}
        />
      )}
      <nav aria-label={t('nav.main')} className={rail ? 'w-16' : ''}>
        <NavList model={model} variant={rail ? 'rail' : 'side'} />
      </nav>
      <div className="grow" />
      <AccountMenu
        name={me.displayName}
        email={me.email}
        variant={rail ? 'rail' : 'side'}
        sourceUrl={sourceUrl}
      />
    </div>
  );
}

/*
 * What a page can ask of the shell: the phone menu's open state, so a full page can put its own
 * Menu button in its own top bar, and something to show in the drawer right under Chat, such
 * as chat's conversations. The drawer opens only after a press, so this never changes what the
 * server renders. Also whether chat's conversation list is hidden, kept here so the choice
 * holds on every page and survives leaving chat.
 */
interface ShellControls {
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  setDrawerExtra: (content: ReactNode) => void;
  conversationsHidden: boolean;
  toggleConversations: () => void;
}

const ShellContext = createContext<ShellControls>({
  menuOpen: false,
  setMenuOpen: () => undefined,
  setDrawerExtra: () => undefined,
  conversationsHidden: false,
  toggleConversations: () => undefined,
});

export const useShell = (): ShellControls => use(ShellContext);

/** The Menu button: the phone top bar's, or a full page's own. */
export function MenuButton() {
  const { menuOpen, setMenuOpen } = useShell();
  return (
    <Button
      isIconOnly
      variant="ghost"
      aria-label={t('nav.menu')}
      aria-expanded={menuOpen}
      className="text-foreground"
      onPress={() => setMenuOpen(true)}
    >
      <Icon name="menu" />
    </Button>
  );
}

function MenuDrawer({
  me,
  workspaces,
  current,
  model,
  currentKey,
  sourceUrl,
  extra,
}: ShellProps & { extra: ReactNode }) {
  const { menuOpen, setMenuOpen } = useShell();
  return (
    <Drawer isOpen={menuOpen} onOpenChange={setMenuOpen}>
      <Drawer.Backdrop className="bg-backdrop">
        <Drawer.Content placement="left">
          <Drawer.Dialog
            aria-label={t('nav.menu')}
            className="flex h-full w-80 max-w-[85vw] flex-col bg-surface-secondary px-3 pt-2 pb-3"
          >
            <div className="flex h-12 shrink-0 items-center justify-between pl-2">
              <Brand />
              <Button slot="close" isIconOnly variant="ghost" aria-label={t('nav.closeMenu')}>
                <Icon name="close" />
              </Button>
            </div>
            {current !== null && (
              <WorkspaceSwitcher
                me={me}
                workspaces={workspaces}
                current={current}
                currentKey={currentKey}
                variant="drawer"
              />
            )}
            <div className="mt-3 flex min-h-0 grow flex-col overflow-y-auto">
              <nav aria-label={t('nav.main')}>
                {/* Chat's conversations sit right under Chat, above the other pages (ADR 0110). */}
                <NavList
                  model={model}
                  variant="drawer"
                  onNavigate={() => setMenuOpen(false)}
                  afterChat={extra}
                />
              </nav>
            </div>
            <div className="flex shrink-0 flex-col gap-1 border-t border-border px-1 pt-2.5">
              <AccountMenu
                name={me.displayName}
                email={me.email}
                variant="drawer"
                sourceUrl={sourceUrl}
              />
            </div>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

function PhoneBar({ me, workspaces, current, currentKey, title }: ShellProps) {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-1 border-b border-border bg-surface pr-2 pl-1 lg:hidden">
      <MenuButton />
      <span className="min-w-0 grow truncate text-base font-semibold">{title}</span>
      {current !== null && (
        <WorkspaceSwitcher
          me={me}
          workspaces={workspaces}
          current={current}
          currentKey={currentKey}
          variant="bar"
        />
      )}
    </header>
  );
}

/**
 * `fullPage`: the page brings its own main landmark and phone top bar, and fills the space
 * beside the side menu, as chat does.
 */
export function AppShell(props: ShellProps & { fullPage?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [extra, setDrawerExtra] = useState<ReactNode>(null);
  const [rail, setRail] = useState(props.layout.rail);
  const [conversationsHidden, setConversationsHidden] = useState(props.layout.conversationsHidden);

  // A toggle is replaced by its opposite, so focus would fall to the page. It stays on the
  // button that took the toggle's place (docs/design/docs/accessibility.md, Chat, desktop).
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    if (focusAfter.current === null) return;
    document.getElementById(focusAfter.current)?.focus();
    focusAfter.current = null;
  }, [rail, conversationsHidden]);

  const toggleRail = useCallback(() => {
    focusAfter.current = MENU_TOGGLE;
    setRail(!rail);
    rememberRail(!rail);
  }, [rail]);
  const toggleConversations = useCallback(() => {
    focusAfter.current = conversationsHidden ? CONVERSATIONS_HIDE : CONVERSATIONS_SHOW;
    setConversationsHidden(!conversationsHidden);
    rememberConversationsHidden(!conversationsHidden);
  }, [conversationsHidden]);

  const controls = useMemo(
    () => ({ menuOpen, setMenuOpen, setDrawerExtra, conversationsHidden, toggleConversations }),
    [menuOpen, conversationsHidden, toggleConversations],
  );
  return (
    <ShellContext value={controls}>
      <div className="flex min-h-screen">
        <SideMenu {...props} rail={rail} onToggle={toggleRail} />
        {props.fullPage === true ? (
          <div className="flex h-dvh min-w-0 grow flex-col lg:h-screen">{props.children}</div>
        ) : (
          <div className="flex min-w-0 grow flex-col">
            <PhoneBar {...props} />
            <main id="main" className="flex grow flex-col gap-6 p-4 lg:px-10 lg:pt-8 lg:pb-12">
              {props.children}
            </main>
          </div>
        )}
      </div>
      <MenuDrawer {...props} extra={extra} />
    </ShellContext>
  );
}
