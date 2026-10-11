import { useEffect, useId, useRef } from 'react';
import { Button } from '@heroui/react';
import { t, tNodes } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';
import { CodeBlock } from './code-block.tsx';

/*
 * Pattern 9, the tool approval card (TL-4, TL-5). A tool asks to run as the person; they
 * answer here. Allow once comes first, then Always allow, then Deny. Focus moves to the card's
 * heading when it appears, and Esc does not answer it.
 *
 * The arguments are untrusted data from the model (NF-S8): shown as plain text in a code
 * block, never as markup or links. React escapes them; nothing here parses them.
 *
 * An approval that belongs to an API key cannot be answered in chat: KeyApprovalNotice says
 * where it can be.
 */

const mono = (text: string, key: string) => (
  <span key={key} className="font-mono">
    {text}
  </span>
);

export function ToolApprovalCard({
  tool,
  source,
  args,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  isPending = false,
  focusOnMount = true,
}: {
  /** The tool's name as the server gives it: github.create_pull_request. */
  tool: string;
  /** Where it comes from and whom it acts as, in one sentence. */
  source: string;
  /** The arguments, already formatted as plain text lines. */
  args: string;
  onAllowOnce: () => void;
  onAlwaysAllow: () => void;
  onDeny: () => void;
  isPending?: boolean;
  focusOnMount?: boolean;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 lk-card border-field-border p-4"
    >
      <div className="flex gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground"
        >
          <Icon name="tools" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="text-heading outline-none">
            {tNodes('approval.title', { tool: mono(tool, 'tool') })}
          </h2>
          <p className="text-small text-muted">{source}</p>
        </div>
      </div>
      <CodeBlock>{args}</CodeBlock>
      {/* On a phone Allow once takes the full width, the other two share a row under it. */}
      <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap">
        <Button
          variant="primary"
          className="col-span-2"
          isPending={isPending}
          onPress={onAllowOnce}
        >
          {t('approval.allowOnce')}
        </Button>
        <Button variant="tertiary" isDisabled={isPending} onPress={onAlwaysAllow}>
          {t('approval.alwaysAllow')}
        </Button>
        <Button variant="outline" isDisabled={isPending} onPress={onDeny}>
          {t('approval.deny')}
        </Button>
      </div>
      <p className="text-small text-muted">{t('approval.alwaysNote')}</p>
    </section>
  );
}

export function KeyApprovalNotice({ keyName, tool }: { keyName: string; tool: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-dashed border-field-border px-4 py-3">
      <span className="mt-0.5 text-muted">
        <Icon name="key" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 text-body">
        <h2 className="font-semibold">{t('approval.key.title', { key: keyName })}</h2>
        <span className="text-muted">
          {tNodes('approval.key.body', { key: keyName, tool: mono(tool, 'tool') })}
        </span>
      </div>
    </div>
  );
}
