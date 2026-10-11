import type { ReactNode } from 'react';
import { Chip } from '@heroui/react';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';

/*
 * The one read-only chip (patterns.md, Controls): 24px, 12px 500 text, 8px in from each side,
 * full corners, 28px with 13px text on a phone: HeroUI's md size, whose values are set from
 * tokens in app.css. Here a chip names its tone, and HeroUI's soft colors draw it, so no screen
 * retypes a color pair.
 *
 * - success, warning, danger and accent use their -soft fill and foreground.
 * - neutral is the --default fill.
 * - outline is neutral and outlined: the --surface fill with a --field-border edge, as admin
 *   role chips are drawn (tokens.md: "Admin role chips are neutral and outlined").
 * - cheaper and refused are the routing decisions' pairs (--lk-decision-fallback and
 *   --lk-decision-refused), which HeroUI has no color for.
 *
 * A state that carries meaning, such as money left, comes with an icon as well as words
 * (tokens.md), never the color alone.
 */

export type Tone =
  | 'neutral'
  | 'outline'
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent'
  | 'cheaper'
  | 'refused';

const COLOR = {
  neutral: 'default',
  outline: 'default',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  accent: 'accent',
  cheaper: 'default',
  refused: 'default',
} as const;

const OWN: Partial<Record<Tone, string>> = {
  outline: 'lk-chip-outline',
  cheaper: 'bg-lk-fallback-soft text-lk-fallback',
  refused: 'bg-lk-refused-soft text-lk-refused',
};

const SOFT: ReadonlySet<Tone> = new Set(['success', 'warning', 'danger', 'accent']);

export function StatusChip({
  tone,
  icon,
  children,
  className = '',
}: {
  tone: Tone;
  icon?: IconName;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Chip
      size="md"
      color={COLOR[tone]}
      variant={SOFT.has(tone) ? 'soft' : 'secondary'}
      className={`${OWN[tone] ?? ''} ${className}`}
    >
      {icon !== undefined && <Icon name={icon} className="size-3.5" />}
      {children}
    </Chip>
  );
}
