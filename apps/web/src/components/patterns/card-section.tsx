import { createContext, use, useId } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import { t } from '../../i18n/index.ts';

/*
 * Pattern 14, the card header, the inner table and paging.
 *
 * - A card is 24px in on every side (tokens.md, Spacing); a compact one, such as Spend by day,
 *   is 16px in at the top and bottom and 20px at the sides, like a stat tile. A flush card, whose
 *   table runs edge to edge, starts 16px from the top, with its header 20px in to line up with
 *   the table's first column and 12px above the table.
 *
 * - A card's note goes under its title as a subtitle, never beside it. Actions such as Add a
 *   route sit at the right of the header. A chip that says the card's state, such as In use,
 *   sits right after the title (badge).
 * - In a flush card, what is not the table (an error notice above it) goes in CardInset, 20px
 *   in, level with the table's first column.
 * - An empty list says so in one muted line, EmptyList, inside its card under the header, or as
 *   a card of its own where the list has no card (ADR 0112). Nothing yet and nothing matching a
 *   filter read the same.
 * - The title's id labels the table inside (DataTable's labelledBy).
 * - Paging sits under the card, outside it: the count on the left, Previous and Next on the
 *   right, in a nav named Pages. On the first page Previous uses aria-disabled, so it stays
 *   focusable. Lists sorted by time say Newer and Older.
 */

/** Whether the card around a part is flush; null outside a card. */
const Card = createContext<{ flush: boolean } | null>(null);

export function CardSection({
  title,
  subtitle,
  headingLevel = 2,
  badge,
  actions,
  children,
  flush = false,
  compact = false,
  titleId,
}: {
  title: string;
  subtitle?: string;
  headingLevel?: 2 | 3;
  /** Right after the title: a chip that says the card's state. */
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** The content runs edge to edge, as a table that fills its card. */
  flush?: boolean;
  /** 16px in at the top and bottom and 20px at the sides, instead of 24px all round. */
  compact?: boolean;
  /** Pass one to label a table inside by the title. */
  titleId?: string;
}) {
  const ownId = useId();
  const id = titleId ?? ownId;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section
      aria-labelledby={id}
      className={`flex flex-col lk-card ${flush ? 'gap-3 overflow-hidden pt-4' : compact ? 'gap-4 px-5 py-4' : 'gap-4 p-6'}`}
    >
      <div className={`flex flex-wrap items-start justify-between gap-3 ${flush ? 'px-5' : ''}`}>
        <div className="flex min-w-0 flex-col gap-0.5">
          {badge === undefined ? (
            <Heading id={id} className="text-heading">
              {title}
            </Heading>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Heading id={id} className="text-heading">
                {title}
              </Heading>
              {badge}
            </div>
          )}
          {subtitle !== undefined && <p className="text-small text-muted">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <Card value={{ flush }}>{children}</Card>
    </section>
  );
}

/** Something other than the table in a flush card, such as an error notice: 20px in. */
export function CardInset({ children }: { children: ReactNode }) {
  const card = use(Card);
  return card?.flush === true ? <div className="px-5">{children}</div> : children;
}

/**
 * An empty list, said in one muted line at most 780px wide, as a lede is: in its card, under the
 * header, or in a card of its own.
 */
export function EmptyList({ children }: { children: ReactNode }) {
  const card = use(Card);
  const line = <p className="max-w-195 text-small text-muted">{children}</p>;
  if (card === null) return <div className="lk-card p-6">{line}</div>;
  return card.flush ? <div className="px-5 pb-5">{line}</div> : line;
}

export function Pager({
  from,
  to,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  byTime = false,
}: {
  from: number;
  to: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** A list sorted by time: Newer and Older instead of Previous and Next. */
  byTime?: boolean;
}) {
  const count = new Intl.NumberFormat('en');
  const firstPage = useId();
  const lastPage = useId();
  return (
    <nav
      aria-label={t('pager.label')}
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="lk-num text-body text-muted">
        {t('pager.showing', {
          from: count.format(from),
          to: count.format(to),
          total: count.format(total),
        })}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          aria-disabled={!hasPrevious}
          {...(hasPrevious ? {} : { 'aria-describedby': firstPage })}
          className="aria-disabled:cursor-not-allowed"
          onPress={() => {
            if (hasPrevious) onPrevious();
          }}
        >
          {byTime ? t('pager.newer') : t('pager.previous')}
        </Button>
        <Button
          variant="outline"
          aria-disabled={!hasNext}
          {...(hasNext ? {} : { 'aria-describedby': lastPage })}
          className="aria-disabled:cursor-not-allowed"
          onPress={() => {
            if (hasNext) onNext();
          }}
        >
          {byTime ? t('pager.older') : t('pager.next')}
        </Button>
      </div>
      <span id={firstPage} hidden>
        {t('pager.firstPage')}
      </span>
      <span id={lastPage} hidden>
        {t('pager.lastPage')}
      </span>
    </nav>
  );
}
