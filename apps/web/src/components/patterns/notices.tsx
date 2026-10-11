import type { ReactNode } from 'react';
import { Alert, Button } from '@heroui/react';
import { Icon } from '../icons.tsx';

/*
 * Patterns 3 and 4: the fallback notice, error alerts and neutral notes.
 *
 * - Errors (CH-7): danger soft fill with its edge, role alert. One plain sentence on what
 *   happened, one on what to do. Never a status code.
 * - Fallback notice (BG-7, CH-4): warning soft, role status, inside the reply. It appears before
 *   the first token and stays with that reply.
 * - Notes: a grey fill, no border, an info icon. Role status in chat, where it is announced,
 *   and role note on a page, where it is read in order and not announced.
 * - Warning notes: what will happen, before it happens (a secret shown once, what a delete
 *   removes). Any note that reports a problem has a border in its own tone (Pattern 4).
 *
 * All are body text, 10px 12px in (notes 10px 14px), with the icon 4px down so it lines up with
 * the first line (tokens.md). HeroUI's Alert sets no role of its own, so each sets one here.
 */

// HeroUI mutes an alert's description; on these fills the board keeps it in the text color.
function Body({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <Alert.Content className="flex min-w-0 flex-col gap-0.5">
      {title !== undefined && <Alert.Title className="font-semibold">{title}</Alert.Title>}
      {children !== undefined && (
        <Alert.Description className="text-current">{children}</Alert.Description>
      )}
    </Alert.Content>
  );
}

/** A button in a notice. The notice draws it in its own tone, so no caller picks a variant. */
export interface NoticeAction {
  label: string;
  onPress: () => void;
  /** The action the notice suggests first, such as Try again. */
  primary?: boolean;
}

export function ErrorNotice({
  title,
  children,
  actions,
  className = '',
}: {
  /** What happened, in one sentence. */
  title: ReactNode;
  /** What to do, in one sentence. */
  children?: ReactNode;
  /**
   * What the person can do about it, such as Try again: the main action as a danger button, the
   * others as danger-soft buttons, which rest on the notice's own fill and darken on hover.
   */
  actions?: readonly NoticeAction[];
  className?: string;
}) {
  return (
    <Alert
      status="danger"
      role="alert"
      className={`items-start gap-2.5 rounded-note border border-lk-danger-edge bg-danger-soft px-3 py-2.5 text-body text-foreground [&_[data-slot=alert-title]]:text-danger-soft-foreground ${className}`}
    >
      <span className="mt-1 text-danger-soft-foreground">
        <Icon name="error" />
      </span>
      <div className="flex min-w-0 grow flex-col gap-2.5">
        <Body title={title}>{children}</Body>
        {actions !== undefined && actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action.label}
                variant={action.primary === true ? 'danger' : 'danger-soft'}
                onPress={action.onPress}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Alert>
  );
}

export function FallbackNotice({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Alert
      status="warning"
      role="status"
      className="items-start gap-2.5 rounded-note border border-lk-warning-edge bg-warning-soft px-3 py-2.5 text-body text-warning-soft-foreground"
    >
      <span className="mt-1">
        <Icon name="cheaper" />
      </span>
      <Body title={title}>{children}</Body>
    </Alert>
  );
}

export function InfoNote({
  title,
  children,
  announce = false,
  icon = 'info',
  className = '',
}: {
  title?: ReactNode;
  children: ReactNode;
  /** The note's icon: info, or a lock for what is kept private (Admin-Diagnostics). */
  icon?: 'info' | 'lock';
  /** True in chat, where the note should be announced when it appears. */
  announce?: boolean;
  className?: string;
}) {
  return (
    <Alert
      status="default"
      role={announce ? 'status' : 'note'}
      className={`items-start gap-2 rounded-note bg-surface-secondary px-3.5 py-2.5 text-body text-foreground ${className}`}
    >
      <span className="mt-1 text-muted">
        <Icon name={icon} />
      </span>
      <Alert.Content className="flex min-w-0 flex-col gap-0.5">
        {title !== undefined && <Alert.Title className="font-semibold">{title}</Alert.Title>}
        <Alert.Description className={title === undefined ? '' : 'text-muted'}>
          {children}
        </Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

const WARNING_LOOK = {
  warning: 'border-lk-warning-edge bg-warning-soft text-warning-soft-foreground',
  danger: 'border-lk-danger-edge bg-danger-soft text-foreground',
} as const;

/** What will happen, said before it does: a secret shown once, what a delete removes. */
export function WarningNote({
  tone = 'warning',
  id,
  children,
}: {
  tone?: keyof typeof WARNING_LOOK;
  /** For a dialog that names the note as its description. */
  id?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="note"
      {...(id === undefined ? {} : { id })}
      className={`flex items-start gap-2.5 rounded-note border px-3 py-2.5 text-body ${WARNING_LOOK[tone]}`}
    >
      <span className={`mt-1 ${tone === 'danger' ? 'text-danger-soft-foreground' : ''}`}>
        <Icon name="warning" />
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}
