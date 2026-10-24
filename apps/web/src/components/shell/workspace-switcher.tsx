import { Dropdown, Label, Separator } from '@heroui/react';
import type { Selection } from 'react-aria-components';
import { useNavigate } from '@tanstack/react-router';
import type { Principal, WorkspaceView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { roleLabel } from '../../lib/roles.ts';
import { Icon } from '../icons.tsx';
import { navItems, navModel } from './nav.ts';
import type { NavKey } from './nav.ts';
import { RailTooltip } from './rail-tooltip.tsx';

/*
 * The workspace switcher: the workspace's name and your role, and a menu of the others. Its
 * name says them as they are shown, then what it does ("Product, Admin. Switch workspace"), so a
 * speech user can say what they see (WCAG 2.5.3, ADR 0129). Switching keeps you on the same page in the other workspace when that page is
 * in its menu, and otherwise opens its chat. "All workspaces" is where instance admins create
 * one.
 */

function Tile({ name, size }: { name: string; size: 'side' | 'drawer' | 'bar' }) {
  const box = size === 'side' ? 'size-7 rounded-lg text-small' : 'size-7.5 rounded-lg';
  return (
    <span
      aria-hidden="true"
      data-initials={name.slice(0, 1).toUpperCase()}
      className={`lk-initials flex shrink-0 items-center justify-center bg-accent-soft font-semibold text-accent-soft-foreground ${box} ${size === 'bar' ? 'text-body' : ''}`}
    />
  );
}

export function WorkspaceSwitcher({
  me,
  workspaces,
  current,
  currentKey,
  variant,
}: {
  me: Pick<Principal, 'isInstanceAdmin'>;
  workspaces: readonly WorkspaceView[];
  current: WorkspaceView;
  /** The menu item for the page being shown, if it is one. */
  currentKey: NavKey | undefined;
  /**
   * `side` and `drawer` show the name and role. `rail` (the collapsed menu) and `bar` (the
   * phone top bar) show the tile alone; the rail's keeps the side one's height.
   */
  variant: 'side' | 'rail' | 'drawer' | 'bar';
}) {
  const navigate = useNavigate();

  function onSelectionChange(keys: Selection) {
    const [key] = keys === 'all' ? [] : [...keys];
    const target = workspaces.find((w) => w.id === key);
    if (target === undefined) return;
    const items = navItems(navModel(me, target));
    const next = items.find((i) => i.key === currentKey) ?? items[0];
    if (next !== undefined) void navigate(next.link);
  }

  // In the menu, the rail and the drawer the switcher is one height, 48px with its border.
  const trigger =
    variant === 'bar'
      ? 'flex size-8 items-center justify-center rounded-lg'
      : `flex h-12 items-center rounded-note border border-border bg-surface ${
          variant === 'rail'
            ? 'mt-4 w-10 justify-center'
            : `w-full gap-2.5 text-left text-foreground ${variant === 'side' ? 'mt-4 px-2.5' : 'mt-2 px-3'}`
        }`;

  const switcher = (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={t('nav.switcher', { name: current.name, role: roleLabel(current.role) })}
        // Its height is fixed: in a menu too short for everything, the menu scrolls instead.
        className={`${trigger} shrink-0 cursor-pointer`}
      >
        <Tile name={current.name} size={variant === 'rail' ? 'side' : variant} />
        {(variant === 'side' || variant === 'drawer') && (
          <>
            <span className="flex min-w-0 grow flex-col">
              {/* A space between the lines, so they read as words, not one run of text. */}
              <span className="truncate text-body leading-tight font-semibold">
                {current.name}
              </span>{' '}
              <span className="text-caption leading-tight text-muted">
                {roleLabel(current.role)}
              </span>
            </span>
            <Icon name="upDown" className="size-3.5 text-muted" />
          </>
        )}
      </Dropdown.Trigger>
      <Dropdown.Popover
        placement={variant === 'rail' ? 'right top' : 'bottom start'}
        className="min-w-56"
      >
        <Dropdown.Menu aria-label={t('nav.switcher.label')}>
          <Dropdown.Section
            aria-label={t('nav.switcher.menu')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[current.id]}
            onSelectionChange={onSelectionChange}
          >
            {workspaces.map((w) => (
              <Dropdown.Item key={w.id} id={w.id} textValue={w.name}>
                <span className="flex min-w-0 grow flex-col leading-tight">
                  <Label className="truncate">{w.name}</Label>
                  <span className="text-caption text-muted">{roleLabel(w.role)}</span>
                </span>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section aria-label={t('nav.switcher.all')}>
            <Dropdown.Item
              id="all"
              textValue={t('nav.switcher.all')}
              onAction={() => void navigate({ to: '/workspaces' })}
            >
              <Label>{t('nav.switcher.all')}</Label>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
  return variant === 'rail' ? (
    <RailTooltip label={t('nav.switcher.label')}>{switcher}</RailTooltip>
  ) : (
    switcher
  );
}
