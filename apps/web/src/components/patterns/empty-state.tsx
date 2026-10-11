import { useId } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';

/*
 * An empty state in place of a whole page's content (Spend-States "No spend yet"): a card 32px in
 * (tokens.md), an optional 40px icon tile, the title in the dialog-title style, at most 480px of
 * body text, then what to do about it. An empty section that will hold a table keeps its card's
 * heading instead (CardSection), as Tools, Routing and Workspace settings do.
 */
export function EmptyState({
  title,
  icon,
  titleId,
  children,
  action,
}: {
  title: string;
  icon?: IconName;
  /** Pass one to label something else by the title. */
  titleId?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const ownId = useId();
  const id = titleId ?? ownId;
  return (
    <section aria-labelledby={id} className="flex flex-col items-start gap-3.5 lk-card p-8">
      {icon !== undefined && (
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-note bg-accent-soft text-accent-soft-foreground"
        >
          <Icon name={icon} className="size-5" />
        </span>
      )}
      <h2 id={id} className="text-dialog-title">
        {title}
      </h2>
      <div className="flex max-w-120 flex-col gap-2">{children}</div>
      {action}
    </section>
  );
}
