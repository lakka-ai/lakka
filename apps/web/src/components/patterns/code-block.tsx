import type { ReactNode } from 'react';

/*
 * A code block (patterns.md, Controls): mono 13/20, 10px 12px in, 8px corners, on the code
 * background. Long lines scroll sideways, so code keeps its indentation (ADR 0108); tool arguments
 * and what a trace recorded do the same (ADR 0112). Because it scrolls, it takes keyboard focus,
 * with the focus ring. Its text is plain: never rendered as markup or links (Pattern 9).
 *
 * - `capped` holds it to 16rem tall, scrolling down too: a tool's result, a recorded prompt.
 */
export function CodeBlock({
  children,
  capped = false,
  className = '',
}: {
  children: ReactNode;
  capped?: boolean;
  className?: string;
}) {
  return (
    <pre
      tabIndex={0}
      className={`lk-focus overflow-x-auto rounded-lg bg-lk-code px-3 py-2.5 font-mono text-small ${capped ? 'max-h-64 overflow-y-auto' : ''} ${className}`}
    >
      {children}
    </pre>
  );
}
