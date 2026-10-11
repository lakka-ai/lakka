import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link, useLinkProps } from '@tanstack/react-router';
import { Focusable } from 'react-aria-components';
import { t } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';
import type { NavItem, NavModel } from './nav.ts';
import { RailTooltip } from './rail-tooltip.tsx';

/*
 * The main menu's links, drawn three ways: `side` for the desktop side menu, `rail` for the
 * same menu collapsed to icons, and `drawer` for the phone drawer, with 44px targets. The router
 * marks the current page with aria-current="page". The current item uses the accent soft pair,
 * and its icon takes the text color.
 *
 * Every rail item has the height and the gaps of its side item, so nothing moves up or down
 * when the menu collapses or expands (docs/design/docs/patterns.md, Collapsed menu).
 */

type Variant = 'side' | 'rail' | 'drawer';

const item: Record<Variant, string> = {
  side: 'h-8.5 gap-2.5 px-2.5 text-body rounded-lg',
  rail: 'h-8.5 w-10 justify-center rounded-lg',
  drawer: 'h-11 gap-3 px-3 text-body rounded-note',
};
const chatItem: Record<Variant, string> = {
  side: 'h-10 gap-2.5 px-2 text-heading rounded-lg',
  rail: 'h-10 w-10 justify-center rounded-lg',
  drawer: 'h-11 gap-3 px-2 text-body font-semibold rounded-note',
};
const heading: Record<Variant, string> = {
  side: 'px-2.5 pt-4 pb-1 text-caption',
  rail: 'w-16 pt-4 pb-1 text-center text-caption',
  drawer: 'px-3 pt-4 pb-1 text-caption',
};

// The focus ring is drawn 2px inside the item: the items are 2px apart, so a ring outside one
// would cover its neighbours, as in the conversation list and the pickers' lists.
const linkBase =
  'flex items-center text-foreground no-underline hover:bg-default lk-focus-inset ' +
  'aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-soft-foreground aria-[current=page]:font-semibold ' +
  '[&>svg]:text-muted aria-[current=page]:[&>svg]:text-current';

function ChatTile() {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"
    >
      <Icon name="chat" />
    </span>
  );
}

/** An icon alone, named by its aria-label and a tooltip. */
function RailLink({ navItem }: { navItem: NavItem }) {
  const isChat = navItem.key === 'chat';
  const label = t(navItem.label);
  // The router's props on a plain anchor, so Focusable can hand it the tooltip's trigger props.
  const props = useLinkProps({
    ...navItem.link,
    'aria-label': label,
    className: `${linkBase} ${isChat ? chatItem.rail : item.rail}`,
  });
  return (
    <li>
      <RailTooltip label={label}>
        <Focusable>
          <a {...props}>{isChat ? <ChatTile /> : <Icon name={navItem.icon} />}</a>
        </Focusable>
      </RailTooltip>
    </li>
  );
}

function NavLink({
  navItem,
  variant,
  onNavigate,
}: {
  navItem: NavItem;
  variant: Variant;
  onNavigate: (() => void) | undefined;
}) {
  if (variant === 'rail') return <RailLink navItem={navItem} />;
  const isChat = navItem.key === 'chat';
  return (
    <li>
      <Link
        {...navItem.link}
        className={`${linkBase} ${isChat ? chatItem[variant] : item[variant]}`}
        onClick={onNavigate}
      >
        {isChat ? <ChatTile /> : <Icon name={navItem.icon} />}
        {t(navItem.label)}
      </Link>
    </li>
  );
}

export function NavList({
  model,
  variant,
  onNavigate,
  afterChat,
}: {
  model: NavModel;
  variant: Variant;
  /** Called when a link is followed, so the drawer can close. */
  onNavigate?: () => void;
  /** Shown right under Chat: chat's conversations, in the phone drawer. */
  afterChat?: ReactNode;
}) {
  const adminHeading = useId();
  return (
    <>
      {model.chat !== null && (
        <ul
          className={`border-b border-border pb-2.5 ${variant === 'drawer' ? '' : 'mt-3.5'} ${variant === 'rail' ? 'mx-auto w-10' : ''}`}
          role="list"
        >
          <NavLink navItem={model.chat} variant={variant} onNavigate={onNavigate} />
        </ul>
      )}
      {afterChat}
      {model.workspace.length > 0 && (
        <ul
          className={`flex flex-col ${variant === 'drawer' ? 'mt-2.5' : 'mt-2.5 gap-0.5'} ${variant === 'rail' ? 'items-center' : ''}`}
          role="list"
        >
          {model.workspace.map((navItem) => (
            <NavLink
              key={navItem.key}
              navItem={navItem}
              variant={variant}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
      {model.admin.length > 0 && (
        <>
          <h2 id={adminHeading} className={`font-semibold text-muted ${heading[variant]}`}>
            {t('nav.admin')}
          </h2>
          <ul
            aria-labelledby={adminHeading}
            className={`flex flex-col ${variant === 'drawer' ? '' : 'gap-0.5'} ${variant === 'rail' ? 'items-center' : ''}`}
            role="list"
          >
            {model.admin.map((navItem) => (
              <NavLink
                key={navItem.key}
                navItem={navItem}
                variant={variant}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
