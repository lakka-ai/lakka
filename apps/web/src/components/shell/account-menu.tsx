import { Description, Dropdown, Label } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t } from '../../i18n/index.ts';
import { RailTooltip } from './rail-tooltip.tsx';

/*
 * The account at the foot of the menu: a 48px button with a round 28px avatar, the name and the
 * email under it (30px avatar and phone sizes in the drawer). The boards name it "Account: Maja
 * Lind" and draw nothing behind it, so it opens a menu with Sign out, the one account action the
 * web app has.
 *
 * The menu also holds the AGPL notice (AD-6, AGPL section 13): a link to the source of the
 * version running, with the sentence that says why. The design moves it to a Settings page that
 * is not drawn yet; until then this is the one place on every signed-in page, the collapsed
 * menu and the phone drawer included (ADR 0107).
 */

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('');

export function AccountMenu({
  name,
  email,
  variant,
  sourceUrl,
}: {
  name: string;
  /** Shown under the name, and in the rail's tooltip (patterns.md, Account row). */
  email: string | null;
  /** `rail`: the avatar alone, in the collapsed menu. */
  variant: 'side' | 'rail' | 'drawer';
  sourceUrl: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function signOut() {
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    queryClient.clear();
    await navigate({ to: '/sign-in' });
  }

  const trigger = {
    side: 'h-12 w-full gap-2.5 px-2.5',
    rail: 'h-12 w-10 justify-center',
    drawer: 'min-h-12 w-full gap-2.5 px-1',
  }[variant];

  const menu = (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={t('nav.account', { name })}
        className={`flex cursor-pointer items-center rounded-lg text-left text-foreground hover:bg-default ${trigger}`}
      >
        <span
          aria-hidden="true"
          className={`flex shrink-0 items-center justify-center rounded-full bg-surface-tertiary text-caption font-semibold ${variant === 'drawer' ? 'size-7.5' : 'size-7'}`}
        >
          {initials(name)}
        </span>
        {variant !== 'rail' && (
          <span className="flex min-w-0 grow flex-col leading-tight">
            <span className="truncate text-body font-medium">{name}</span>
            {email !== null && (
              <span
                className={`truncate text-muted ${variant === 'drawer' ? 'text-small' : 'text-caption'}`}
              >
                {email}
              </span>
            )}
          </span>
        )}
      </Dropdown.Trigger>
      <Dropdown.Popover
        placement={variant === 'rail' ? 'right bottom' : 'top start'}
        className="max-w-72 min-w-48"
      >
        <Dropdown.Menu aria-label={t('nav.account', { name })}>
          <Dropdown.Item id="source" href={sourceUrl} textValue={t('app.source')}>
            <span className="flex flex-col gap-0.5">
              <Label>{t('app.source')}</Label>
              <Description>{t('app.license')}</Description>
            </span>
          </Dropdown.Item>
          <Dropdown.Item id="sign-out" textValue={t('nav.signOut')} onAction={() => void signOut()}>
            <Label>{t('nav.signOut')}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
  return variant === 'rail' ? (
    <RailTooltip label={email === null ? name : `${name}, ${email}`}>{menu}</RailTooltip>
  ) : (
    menu
  );
}
