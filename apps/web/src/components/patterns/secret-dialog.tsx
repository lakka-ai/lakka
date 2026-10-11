import { useState } from 'react';
import { AlertDialog, Button, Input, Label, TextArea, TextField } from '@heroui/react';
import { t } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';
import { WarningNote } from './notices.tsx';

/*
 * Pattern 5, the one-time secret dialog: the recovery key, API keys, invite links and webhook
 * signing secrets are shown here once and never again (ID-5, ID-7, AD-1).
 *
 * - An alertdialog with no close button. Esc and clicking outside do nothing; "I have saved it"
 *   is the only way out, and react-aria then returns focus to what opened it.
 * - Focus starts on Copy. Copy says "Copied to the clipboard." in a status line; when the
 *   clipboard is not available (plain HTTP on a network address) it says so, and the text can
 *   still be selected.
 */

export interface SecretDialogProps {
  isOpen: boolean;
  /** Called by "I have saved it". */
  onSaved: () => void;
  title: string;
  /** What happens if it is lost: "This is the only time the key is shown. ..." */
  warning: string;
  label: string;
  secret: string;
  /** Long secrets, such as the recovery key, show in a text area. */
  multiline?: boolean;
  /** Offers a Download button that saves the secret to this file name. */
  downloadName?: string;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function SecretDialog({
  isOpen,
  onSaved,
  title,
  warning,
  label,
  secret,
  multiline = false,
  downloadName,
}: SecretDialogProps) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  const copyButton = (
    <Button size="lg" variant="tertiary" autoFocus onPress={() => void onCopy()}>
      <Icon name="copy" />
      {t('common.copy')}
    </Button>
  );

  return (
    // Controlled and never dismissed from inside: only "I have saved it" closes it.
    <AlertDialog isOpen={isOpen}>
      <AlertDialog.Backdrop isDismissable={false} isKeyboardDismissDisabled className="bg-backdrop">
        <AlertDialog.Container placement="auto" size="lg" className="lk-sheet">
          <AlertDialog.Dialog className="lk-dialog">
            <AlertDialog.Header className="lk-dialog-header">
              <AlertDialog.Heading className="text-dialog-title font-semibold">
                {title}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="lk-dialog-body">
              <WarningNote>
                <p>{warning}</p>
              </WarningNote>
              <div className="flex flex-col gap-1.5">
                {multiline ? (
                  <TextField isReadOnly value={secret}>
                    <Label>{label}</Label>
                    <TextArea rows={3} className="font-mono" spellCheck={false} />
                  </TextField>
                ) : (
                  <TextField isReadOnly value={secret}>
                    <Label>{label}</Label>
                    <div className="flex gap-2">
                      <Input className="min-w-0 grow font-mono" spellCheck={false} />
                      {copyButton}
                    </div>
                  </TextField>
                )}
                {multiline && (
                  <div className="flex flex-wrap gap-2">
                    {copyButton}
                    {downloadName !== undefined && (
                      <Button
                        size="lg"
                        variant="outline"
                        onPress={() => download(downloadName, secret)}
                      >
                        <Icon name="download" />
                        {t('common.download')}
                      </Button>
                    )}
                  </div>
                )}
                <p role="status" className="min-h-5 text-small text-muted">
                  {copy === 'copied'
                    ? t('common.copied')
                    : copy === 'failed'
                      ? t('common.copyFailed')
                      : ''}
                </p>
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer className="lk-dialog-footer">
              <Button variant="primary" onPress={onSaved}>
                {t('secret.saved')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
