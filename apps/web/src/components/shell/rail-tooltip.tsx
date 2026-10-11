import type { ReactNode } from 'react';
import { Tooltip } from '@heroui/react';

/*
 * The name of an icon-only control in the collapsed menu, shown beside it on hover and on
 * keyboard focus (docs/design/docs/accessibility.md, Collapsed menu). The control keeps its own
 * aria-label; the tooltip is for sighted people.
 *
 * The child must take the trigger's props itself: a react-aria button does, and a link does
 * through Focusable. HeroUI's Tooltip.Trigger is not used, because it wraps its child in a div
 * with role="button", which would nest one control inside another.
 */
export function RailTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip closeDelay={0}>
      {children}
      <Tooltip.Content placement="right" offset={8}>
        {label}
      </Tooltip.Content>
    </Tooltip>
  );
}
