import type { ReactNode } from 'react';

/*
 * A page's header (tokens.md, Spacing; every page board): the title, the lede 4px under it and
 * at most 780px wide, and the page's actions on the right, 24px away. Actions line up with the
 * bottom of the lede, as the boards draw them; the trace page's outcome chip lines up with the
 * top instead. On a narrow screen the actions wrap under the lede, and stay within its width.
 */
export function PageHeader({
  title,
  lede,
  actions,
  alignActions = 'end',
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  alignActions?: 'start' | 'end';
}) {
  return (
    <header
      className={`flex flex-wrap justify-between gap-x-6 gap-y-4 ${alignActions === 'end' ? 'items-end' : 'items-start'}`}
    >
      <div className="flex max-w-195 min-w-0 flex-col gap-1">
        <h1 className="lk-title">{title}</h1>
        {lede !== undefined && <p className="text-muted">{lede}</p>}
      </div>
      {/* No wider than the header, so actions too wide for a phone (the date pills) scroll in
          their own row rather than widen the page. */}
      {actions !== undefined && (
        <div className="flex max-w-full min-w-0 flex-wrap gap-2">{actions}</div>
      )}
    </header>
  );
}
