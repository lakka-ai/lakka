import { useId } from 'react';
import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';
import { Button, Label, TextField } from '@heroui/react';
import { FileTrigger, TextArea } from 'react-aria-components';
import type { InputSupport } from '@lakka/contracts';
import { ATTACHMENT_MEDIA_TYPES } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { LONG_PASTE_CHARS, pastedFiles, TEXT_ACCEPT } from '../../lib/attachments.ts';
import { formatBytes } from '../../lib/format.ts';
import { Icon } from '../icons.tsx';

/*
 * The message box (docs/design/docs/accessibility.md, Chat states). Enter sends; Shift and Enter
 * together add a line. Files are checked when they are picked, each on its own: a file that
 * cannot be sent stays in the list, marked, with what is wrong, and is tied to Attach files
 * through aria-describedby. When Send cannot be used it says why through aria-disabled and a
 * description, and stays focusable. While a reply is being written, Send becomes Stop.
 *
 * Files can also be dropped on the conversation, which the box shows while they are dragged
 * over it, or pasted into the box; a paste longer than a page becomes a text document
 * (ADR 0106). Dropping is for a pointer only; Attach files and pasting do the same by keyboard.
 */

/** A file chosen for the next message: read and ready, or marked with what is wrong with it. */
export interface PendingFile {
  key: string;
  name: string;
  mediaType: string;
  size: number;
  /** The file as a base64 data URL, as the OpenAI format sends it inline. */
  dataUrl: string | null;
  /** A text file whose bytes are not UTF-8, which cannot be sent (ADR 0106). */
  notText?: boolean;
  problem: string | null;
}

export const MESSAGE_BOX_ID = 'message-box';

const IMAGE_TYPES = ATTACHMENT_MEDIA_TYPES.filter((type) => type.startsWith('image/'));

/** What Attach files offers: text always, since every model reads it, then what the model reads. */
export function acceptedTypes(support: InputSupport): string[] {
  return [
    ...(support.images ? IMAGE_TYPES : []),
    ...(support.pdf ? ['application/pdf'] : []),
    ...TEXT_ACCEPT,
  ];
}

/** Enter sends; Shift and Enter, or Enter while composing text, adds a line. */
function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

export function Composer({
  text,
  onText,
  files,
  onPick,
  onLongPaste,
  dropping,
  onRemove,
  onSubmit,
  onStop,
  streaming,
  busy,
  support,
  status,
  usedUp,
}: {
  text: string;
  onText: (text: string) => void;
  files: readonly PendingFile[];
  /** Files from Attach files, a drop or a paste. */
  onPick: (files: readonly File[]) => void;
  /** A paste too long for message text, to become a document. */
  onLongPaste: (text: string) => void;
  /** Files are being dragged over the conversation: the box offers to take them. */
  dropping: boolean;
  onRemove: (key: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  /** A reply is being written: Send becomes Stop. */
  streaming: boolean;
  /** A send is on its way or finishing: nothing new can be sent yet. */
  busy: boolean;
  support: InputSupport;
  /** A line under the box, such as "Waiting for your answer to the tool request." */
  status: string;
  /** Why nothing can be sent while a cap is used up, or null. */
  usedUp: string | null;
}) {
  const fileNotes = useId();
  const sendWhy = useId();
  const marked = files.filter((f) => f.problem !== null);
  const empty = text.trim() === '' && files.length === 0;
  const blocked =
    marked.length > 0
      ? marked.length === 1
        ? t('chat.files.fixOne')
        : t('chat.files.fixMany')
      : null;
  const why = busy
    ? t('chat.sendWaiting')
    : usedUp !== null
      ? usedUp
      : empty
        ? t('chat.sendNeeds')
        : blocked;

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedText = event.clipboardData.getData('text/plain');
    const attached = pastedFiles([...event.clipboardData.files], pastedText);
    if (attached.length > 0) {
      event.preventDefault();
      onPick(attached);
    } else if (pastedText.length > LONG_PASTE_CHARS) {
      event.preventDefault();
      onLongPaste(pastedText);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (why === null) onSubmit();
  }

  // One composer for every width: on a phone the box, Attach and Send share a row, and the
  // button words become their names; from 1024px Attach and Send sit on a row under the box.
  const attach = (
    <FileTrigger
      acceptedFileTypes={acceptedTypes(support)}
      allowsMultiple
      onSelect={(list) => onPick([...(list ?? [])])}
    >
      <Button
        variant="ghost"
        isDisabled={busy}
        {...(marked.length > 0 ? { 'aria-describedby': fileNotes } : {})}
        className={`lk-icon-only-phone order-2 gap-1.5 lg:order-3 ${
          dropping ? 'text-accent-soft-foreground' : ''
        }`}
      >
        {/* While files are dragged over the conversation, the button says where they go. */}
        <Icon name={dropping ? 'drop' : 'paperclip'} />
        <span className="sr-only lg:not-sr-only">
          {dropping ? t('chat.files.drop') : t('chat.files.attach')}
        </span>
      </Button>
    </FileTrigger>
  );

  const send = streaming ? (
    <Button
      variant="outline"
      onPress={onStop}
      className="lk-icon-only-phone order-3 gap-1.5 lg:order-6"
    >
      <Icon name="stop" />
      <span className="sr-only lg:not-sr-only">{t('chat.stop')}</span>
    </Button>
  ) : (
    <Button
      type="submit"
      variant="primary"
      aria-disabled={why !== null}
      {...(why === null ? {} : { 'aria-describedby': sendWhy })}
      className="lk-icon-only-phone order-3 gap-1.5 lg:order-6"
    >
      <span className="sr-only lg:not-sr-only">{t('chat.send')}</span>
      <Icon name="send" />
    </Button>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {files.length > 0 && (
        <ul aria-label={t('chat.files.listLabel')} className="flex flex-col gap-2">
          {files.map((f) => (
            <li
              key={f.key}
              className={`flex flex-col gap-1 rounded-note border px-3 py-2 text-body ${
                f.problem === null
                  ? 'border-border bg-surface'
                  : 'border-lk-danger-edge bg-danger-soft text-danger-soft-foreground'
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon name={f.mediaType.startsWith('image/') ? 'image' : 'file'} />
                <span className="min-w-0 grow truncate">{f.name}</span>
                <span className={`lk-num text-caption ${f.problem === null ? 'text-muted' : ''}`}>
                  {formatBytes(f.size)}
                </span>
                <Button
                  isIconOnly
                  variant="ghost"
                  aria-label={t('chat.files.remove', { name: f.name })}
                  onPress={() => onRemove(f.key)}
                >
                  <Icon name="close" className="size-3.5" />
                </Button>
              </span>
              {f.problem !== null && <span className="text-small">{f.problem}</span>}
            </li>
          ))}
        </ul>
      )}
      <div
        // The box is the field: its edge is the field border, and the focus ring goes round it while
        // the message box has focus, not while Attach or Send does, which ring themselves.
        className={`flex flex-col gap-2 rounded-xl border px-3 py-2.5 has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-focus lg:px-4 lg:py-3 ${
          dropping ? 'border-dashed border-accent bg-accent-soft' : 'border-field-border bg-field'
        }`}
      >
        <div className="flex flex-wrap items-end gap-1 lg:items-center lg:gap-3">
          <TextField
            id={MESSAGE_BOX_ID}
            value={text}
            onChange={onText}
            className="order-1 min-w-0 grow basis-0 lg:basis-full"
          >
            <Label className="sr-only">{t('chat.message')}</Label>
            {/*
             * react-aria's own textarea, unstyled: the box around it carries the border and the
             * focus ring, where HeroUI's would draw its own. On a phone the buttons sit beside it,
             * held to the bottom as lines are added: one line is their height, so its text lines
             * up with them.
             */}
            <TextArea
              rows={1}
              placeholder={t('chat.messagePlaceholder')}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              className="max-h-38 min-h-9.5 w-full resize-none py-2 text-chat text-field-foreground outline-none placeholder:text-field-placeholder max-lg:min-h-0 max-lg:py-[calc((var(--lk-button-height-md)_-_1lh)/2)] lg:max-h-60 [field-sizing:content]"
            />
          </TextField>
          {attach}
          <span aria-hidden="true" className="order-4 hidden grow lg:block" />
          <span className="order-5 hidden text-caption text-muted lg:inline">
            {streaming ? t('chat.status.writing') : t('chat.enterToSend')}
          </span>
          {send}
        </div>
      </div>
      <p id={fileNotes} className={blocked === null ? 'sr-only' : 'text-small text-muted'}>
        {blocked ?? ''}
      </p>
      <span id={sendWhy} className="sr-only">
        {why ?? ''}
      </span>
      {status !== '' && <p className="ps-1 text-caption text-muted">{status}</p>}
    </form>
  );
}
