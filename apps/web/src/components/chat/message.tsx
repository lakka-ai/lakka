import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Disclosure } from '@heroui/react';
import { Link } from '@tanstack/react-router';
import type { AttachmentView } from '@lakka/contracts';
import { t, tNodes } from '../../i18n/index.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { formatCost } from '../../lib/money.ts';
import { Icon } from '../icons.tsx';
import { CodeBlock } from '../patterns/code-block.tsx';
import { FallbackNotice } from '../patterns/notices.tsx';
import { WhyThisModel } from '../patterns/why-this-model.tsx';
import { chargedText, decisionOf } from './copy.ts';
import { Markdown } from './markdown.tsx';
import { argumentLines, segmentsOf } from './thread.ts';
import type { Reply, ToolUse } from './thread.ts';

/*
 * A turn and a reply, each an article (docs/design/docs/accessibility.md, Chat): "You said",
 * and "Reply from Claude Sonnet 4.5". A reply says which model answered and why (Pattern 1),
 * explains a fallback before its text (Pattern 3), shows its tool calls folded, and ends with
 * its cost, the trace and Copy. Streaming text sits outside any live region; one status line
 * elsewhere says when a reply finished or stopped.
 *
 * Your own turns and tool results are shown as text: React escapes them, and nothing reads them
 * as markup or links (NF-S8). A reply's Markdown is drawn by markdown.tsx, which builds elements
 * itself, drops raw HTML, loads no image and links only to http, https and mailto (ADR 0105).
 */

const mono = (text: string, key: string) => (
  <span key={key} className="font-mono text-small">
    {text}
  </span>
);

function Body({ text }: { text: string }) {
  // Kept to the bubble's width: without the cap a code line wider than the bubble sized this to
  // the code, and the bubble's right alignment pushed the code out past its left edge, instead
  // of letting the code block scroll sideways.
  return (
    <div className="flex max-w-full min-w-0 flex-col gap-3">
      {segmentsOf(text).map((segment, i) =>
        segment.code ? (
          <CodeBlock key={i}>{segment.text}</CodeBlock>
        ) : (
          <p key={i} className="text-chat whitespace-pre-wrap">
            {segment.text}
          </p>
        ),
      )}
    </div>
  );
}

/** A stored file: images shown in place, other files as a link to download (CH-5). */
function Attachment({ file, path }: { file: AttachmentView; path: string }) {
  const url = `${path}/${file.id}`;
  const name = file.filename ?? t('chat.file.unnamed');
  if (file.mediaType.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img
          src={url}
          alt={
            file.filename === null
              ? t('chat.file.imageAltUnnamed')
              : t('chat.file.imageAlt', { name: file.filename })
          }
          className="max-h-48 max-w-full rounded-note border border-border"
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-small text-link underline underline-offset-2"
    >
      <Icon name="file" className="size-3.5" />
      {t('chat.file.link', { name, size: formatBytes(file.sizeBytes) })}
    </a>
  );
}

export function Turn({
  text,
  attachments = [],
  pendingFiles = [],
  filesPath,
}: {
  text: string;
  attachments?: readonly AttachmentView[];
  pendingFiles?: readonly { key: string; name: string; size: number }[];
  filesPath: string;
}) {
  return (
    <li className="flex justify-end">
      <article
        aria-label={t('chat.youSaid')}
        className="flex max-w-75 flex-col items-end gap-2 rounded-2xl rounded-br-sm bg-surface-secondary px-3.5 py-2.5 lg:max-w-3/4 lg:px-4 lg:py-3"
      >
        {text !== '' && <Body text={text} />}
        {(attachments.length > 0 || pendingFiles.length > 0) && (
          <ul className="flex flex-wrap justify-end gap-2">
            {attachments.map((a) => (
              <li key={a.id}>
                <Attachment file={a} path={filesPath} />
              </li>
            ))}
            {pendingFiles.map((f) => (
              <li
                key={f.key}
                className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-small"
              >
                <Icon name="file" className="size-3.5" />
                {t('chat.file.link', { name: f.name, size: formatBytes(f.size) })}
              </li>
            ))}
          </ul>
        )}
      </article>
    </li>
  );
}

function ToolCall({ use }: { use: ToolUse }) {
  // A call that stopped to ask never ran: while it waits, the approval card stands for it, and
  // once the person sends something else instead it has expired. Neither is "Used" (Pattern 9).
  if (use.status === 'approval_required') return null;
  if (use.status === 'denied' || use.status === 'rejected') {
    return (
      <p className="flex items-center gap-2 self-start rounded-note border border-border px-3 py-2 text-body">
        <Icon name="ban" className="size-3.5 text-muted" />
        <span>{tNodes('chat.tool.denied', { tool: mono(use.name, 'tool') })}</span>
      </p>
    );
  }
  const duration = formatDuration(use.durationMs);
  const summary = use.failed
    ? tNodes('chat.tool.failed', { tool: mono(use.name, 'tool') })
    : tNodes('chat.tool.used', { tool: mono(use.name, 'tool') });
  const args = argumentLines(use.arguments);
  return (
    <div className="flex flex-col gap-1.5 self-stretch">
      <Disclosure className="rounded-note border border-border bg-surface">
        <Disclosure.Heading level={2} className="m-0">
          <Disclosure.Trigger className="group lk-inset-focus flex min-h-9 w-full items-center gap-2 rounded-[calc(var(--radius-note)-1px)] px-3 text-left text-body">
            <span className="transition-transform group-aria-expanded:rotate-90">
              <Icon name="chevronRight" className="size-3.5 text-muted" />
            </span>
            <Icon name="tools" className="size-3.5 text-muted" />
            <span className="grow">{summary}</span>
            <span className="lk-num text-caption text-muted">{duration.text}</span>
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <div className="flex flex-col gap-2 border-t border-separator px-3 pt-2 pb-3 text-small">
            {args !== '' && (
              <>
                <span className="text-muted">{t('chat.tool.arguments')}</span>
                <CodeBlock>{args}</CodeBlock>
              </>
            )}
            {use.result !== null && (
              <>
                <span className="text-muted">{t('chat.tool.result')}</span>
                <CodeBlock capped>{use.result}</CodeBlock>
              </>
            )}
          </div>
        </Disclosure.Content>
      </Disclosure>
      {!use.asked && use.status === 'ok' && (
        <p className="text-caption text-muted">{t('chat.tool.ranWithoutAsking')}</p>
      )}
    </div>
  );
}

function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      aria-label={t('chat.copyReplyLabel')}
      className="gap-1.5 text-muted"
      onPress={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      <Icon name="copy" className="size-3.5" />
      {copied ? t('chat.copiedReply') : t('chat.copyReply')}
    </Button>
  );
}

export function ReplyView({
  reply,
  workspaceId,
  streaming = false,
  liveTools = [],
  children,
  onAskAgain,
  quiet = false,
}: {
  reply: Reply;
  workspaceId: string;
  /** True while it arrives: no footer yet, and no trace link. */
  streaming?: boolean;
  /** Tool calls reported while it streams, before the stored conversation has them. */
  liveTools?: readonly { callId: string; name: string }[];
  /** What goes inside the reply after its text: an approval, or an error about it. */
  children?: ReactNode;
  /** Sends the question this reply answered again, for a stopped reply. */
  onAskAgain?: () => void;
  /** Leaves out the broke-off note while an alert says it. */
  quiet?: boolean;
}) {
  const decision = decisionOf(reply.decision);
  const trace = { workspaceId, requestId: reply.requestId };
  const name = reply.modelName === '' ? t('chat.replyWriting') : reply.modelName;
  return (
    <li>
      <article aria-label={t('chat.replyFrom', { model: name })} className="flex flex-col gap-3">
        {reply.decision.fallbackFrom !== null && (
          <FallbackNotice title={t('chat.fallbackNotice.title')}>
            {t('chat.fallbackNotice', {
              from: reply.decision.fallbackFromName ?? reply.decision.fallbackFrom,
              to: name,
            })}
          </FallbackNotice>
        )}
        {reply.modelName !== '' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-semibold">{reply.modelName}</span>
            <WhyThisModel
              decision={{
                ...decision,
                ...(reply.model === null ? {} : { modelId: reply.model }),
                ...(reply.costMicroUsd === null ? {} : { cost: formatCost(reply.costMicroUsd) }),
                ...(streaming || reply.requestId === '' ? {} : { trace }),
              }}
            />
          </div>
        )}
        {reply.text !== '' && <Markdown text={reply.text} />}
        {reply.tools.map((use) => (
          <ToolCall key={use.callId} use={use} />
        ))}
        {liveTools.map((tool) => (
          <p
            key={tool.callId}
            className="flex items-center gap-2 self-start rounded-note border border-border px-3 py-2 text-body"
          >
            <Icon name="tools" className="size-3.5 text-muted" />
            {tNodes('chat.tool.used', { tool: mono(tool.name, 'tool') })}
          </p>
        ))}
        {reply.state === 'aborted' && (
          <div className="flex flex-col gap-2 border-t border-dashed border-border pt-3">
            <p className="flex items-start gap-2 text-body text-muted">
              <Icon name="stop" className="mt-0.5 size-3.5" />
              <span>
                {t('chat.state.aborted')}
                {chargedText(reply.costMicroUsd)}
              </span>
            </p>
          </div>
        )}
        {reply.state === 'interrupted' && !streaming && !quiet && (
          <p className="flex items-start gap-2 text-body text-muted">
            <Icon name="error" className="mt-0.5 size-3.5" />
            {t('chat.state.interrupted')}
          </p>
        )}
        {children}
        {!streaming && reply.requestId !== '' && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small">
            {reply.costMicroUsd !== null && (
              <span className="lk-num text-muted">{formatCost(reply.costMicroUsd)}</span>
            )}
            <Link
              to="/workspaces/$workspaceId/requests/$requestId"
              params={trace}
              className="lk-link lk-link-alone"
            >
              {t('chat.viewTrace')}
            </Link>
            {reply.state === 'aborted' && onAskAgain !== undefined && (
              <Button variant="ghost" className="gap-1.5 text-muted" onPress={onAskAgain}>
                <Icon name="retry" className="size-3.5" />
                {t('chat.askAgain')}
              </Button>
            )}
            {reply.text !== '' && <CopyReply text={reply.text} />}
          </div>
        )}
      </article>
    </li>
  );
}
