import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertDialog, Button, Description, Input, Label, TextField } from '@heroui/react';
import { t, tNodes } from '../../i18n/index.ts';
import { DialogCloseButton } from './form-dialog.tsx';

/*
 * Pattern 10, destructive confirmation.
 *
 * - ConfirmDialog: a plain two-button confirm, for removals that can be undone or redone:
 *   Revoke, Withdraw, Remove cap.
 * - TypedConfirmDialog: for what cannot be undone. The danger button uses aria-disabled until
 *   the typed text matches, so it stays focusable and its description says why.
 *
 * Both are alertdialogs with a close button; Esc and Close cancel, and focus goes back to the
 * button that opened them. What the dialog says, before any field, is its description
 * (aria-describedby), so it is read with the title.
 */

interface BaseProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /**
   * What happens, and what to do first if anything. Text is set as a paragraph; anything else,
   * such as a notice with a list, as it is.
   */
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  isPending?: boolean;
}

function Frame({
  isOpen,
  onOpenChange,
  title,
  children,
  after,
  footer,
}: Pick<BaseProps, 'isOpen' | 'onOpenChange' | 'title' | 'children'> & {
  /** What follows the description, such as the field to type into. */
  after?: ReactNode;
  footer: ReactNode;
}) {
  const described = useId();
  return (
    <AlertDialog isOpen={isOpen} onOpenChange={onOpenChange}>
      <AlertDialog.Backdrop className="bg-backdrop">
        <AlertDialog.Container placement="auto" size="lg" className="lk-sheet">
          <AlertDialog.Dialog className="lk-dialog" aria-describedby={described}>
            <AlertDialog.Header className="lk-dialog-header">
              <AlertDialog.Heading className="text-dialog-title font-semibold">
                {title}
              </AlertDialog.Heading>
              <DialogCloseButton />
            </AlertDialog.Header>
            <AlertDialog.Body className="lk-dialog-body">
              <div id={described} className="flex flex-col gap-4">
                {typeof children === 'string' ? <p>{children}</p> : children}
              </div>
              {after}
            </AlertDialog.Body>
            <AlertDialog.Footer className="lk-dialog-footer">{footer}</AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

export function ConfirmDialog({ confirmLabel, onConfirm, isPending = false, ...frame }: BaseProps) {
  return (
    <Frame
      {...frame}
      footer={
        <>
          <Button variant="tertiary" slot="close">
            {t('common.cancel')}
          </Button>
          <Button variant="danger" isPending={isPending} onPress={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export function TypedConfirmDialog({
  confirmLabel,
  onConfirm,
  isPending = false,
  expected,
  mismatch = t('confirm.noMatch'),
  ...frame
}: BaseProps & {
  /** What must be typed, such as the person's email. */
  expected: string;
  /** Said under the field until it matches. */
  mismatch?: string;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === expected;
  const why = useId();

  return (
    <Frame
      {...frame}
      footer={
        <>
          <Button variant="tertiary" slot="close">
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            aria-disabled={!matches}
            {...(matches ? {} : { 'aria-describedby': why })}
            isPending={isPending}
            className="aria-disabled:cursor-not-allowed"
            onPress={() => {
              if (matches) onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
      after={
        <TextField
          value={typed}
          onChange={setTyped}
          autoFocus
          autoComplete="off"
          spellCheck="false"
        >
          <Label>
            {tNodes('confirm.typeToConfirm', {
              value: (
                <span key="value" className="font-semibold">
                  {expected}
                </span>
              ),
            })}
          </Label>
          <Input />
          <Description id={why} className={matches ? 'sr-only' : ''}>
            {matches ? '' : mismatch}
          </Description>
        </TextField>
      }
    />
  );
}
