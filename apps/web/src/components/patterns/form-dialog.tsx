import { useCallback, useId } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button, Modal } from '@heroui/react';
import { t } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';
import { ErrorNotice } from './notices.tsx';
import type { NoticeAction } from './notices.tsx';

/*
 * Pattern 13, the form dialog. Every add, edit and replace action opens one, and the page
 * underneath stays a list. A Modal, so react-aria traps focus, closes on Esc and returns focus
 * to the button that opened it. Focus starts on the first field. On a phone it is a sheet.
 *
 * Footer: Cancel, then the primary action last, on the right. A destructive action, such as
 * Remove cap, sits bottom left as a danger text button and opens its own confirmation.
 */

export interface FormDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  onSubmit: (form: FormData) => void;
  isSubmitting?: boolean;
  /**
   * Shown above the fields, as an error alert, when saving failed; with what the person can do
   * about it, such as allowing an origin, when there is something.
   */
  error?: { title: string; body?: string; actions?: readonly NoticeAction[] };
  destructive?: { label: string; onPress: () => void };
  /**
   * Why the primary action cannot be used yet, such as an agreement not ticked. The button then
   * uses aria-disabled, stays focusable, and says why through aria-describedby; the reason is
   * not shown on screen.
   */
  blockedBy?: string;
  /**
   * Where focus starts instead of the first field, as a selector inside the body: a dialog
   * opened to finish one thing, such as an example added from a message, starts there. A text
   * area gets the caret at its end, scrolled into view.
   */
  initialFocus?: string;
  children: ReactNode;
}

const FIELD =
  'input:not([type=hidden]):not([readonly]), textarea, select, [role=combobox], button[aria-haspopup=listbox]';

/** The close button in a dialog header: 32px, named Close. */
export function DialogCloseButton() {
  return (
    <Button slot="close" isIconOnly variant="ghost" aria-label={t('common.close')}>
      <Icon name="close" />
    </Button>
  );
}

export function FormDialog({
  isOpen,
  onOpenChange,
  title,
  submitLabel,
  onSubmit,
  isSubmitting = false,
  error,
  destructive,
  blockedBy,
  initialFocus,
  children,
}: FormDialogProps) {
  const blockedId = useId();
  // react-aria focuses the dialog itself when it opens; the first field is where people start.
  const focusFirstField = useCallback(
    (body: HTMLDivElement | null) => {
      if (body === null) return;
      requestAnimationFrame(() => {
        const target = body.querySelector<HTMLElement>(initialFocus ?? FIELD);
        target?.focus();
        if (target instanceof HTMLTextAreaElement) {
          target.setSelectionRange(target.value.length, target.value.length);
          target.scrollTop = target.scrollHeight;
        }
      });
    },
    [initialFocus],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blockedBy === undefined) onSubmit(new FormData(event.currentTarget));
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop className="bg-backdrop">
        <Modal.Container placement="auto" size="lg" className="lk-sheet">
          <Modal.Dialog className="lk-dialog">
            <form onSubmit={submit} className="flex min-h-0 flex-col">
              <Modal.Header className="lk-dialog-header">
                <Modal.Heading className="text-dialog-title font-semibold">{title}</Modal.Heading>
                <DialogCloseButton />
              </Modal.Header>
              <Modal.Body className="lk-dialog-body" ref={focusFirstField}>
                {error !== undefined && (
                  <ErrorNotice
                    title={error.title}
                    {...(error.actions === undefined ? {} : { actions: error.actions })}
                  >
                    {error.body}
                  </ErrorNotice>
                )}
                {children}
              </Modal.Body>
              <Modal.Footer className="lk-dialog-footer">
                {destructive !== undefined && (
                  <Button
                    data-destructive
                    variant="ghost"
                    className="lk-danger-text"
                    onPress={destructive.onPress}
                  >
                    {destructive.label}
                  </Button>
                )}
                <Button variant="tertiary" slot="close">
                  {t('common.cancel')}
                </Button>
                {/* Not shown: the button looks unusable, and a screen reader hears why. */}
                {blockedBy !== undefined && (
                  <span id={blockedId} className="sr-only">
                    {blockedBy}
                  </span>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  isPending={isSubmitting}
                  aria-disabled={blockedBy !== undefined}
                  {...(blockedBy === undefined ? {} : { 'aria-describedby': blockedId })}
                  className="aria-disabled:cursor-not-allowed"
                >
                  {submitLabel}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/**
 * Pattern 13 for a list to act on rather than a form, such as the messages routed to a route:
 * the same anatomy, and one Done button in the footer, which closes it. Focus starts on the
 * dialog, so a screen reader hears its title first.
 */
export function ViewDialog({
  isOpen,
  onOpenChange,
  title,
  doneLabel,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  doneLabel: string;
  children: ReactNode;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop className="bg-backdrop">
        <Modal.Container placement="auto" size="lg" className="lk-sheet">
          <Modal.Dialog className="lk-dialog">
            <Modal.Header className="lk-dialog-header">
              <Modal.Heading className="text-dialog-title font-semibold">{title}</Modal.Heading>
              <DialogCloseButton />
            </Modal.Header>
            <Modal.Body className="lk-dialog-body">{children}</Modal.Body>
            <Modal.Footer className="lk-dialog-footer">
              <Button variant="primary" slot="close" data-done>
                {doneLabel}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
