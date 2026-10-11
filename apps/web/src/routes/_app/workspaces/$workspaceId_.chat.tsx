import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Button, buttonVariants, Skeleton } from '@heroui/react';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import {
  ATTACHMENT_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  TEXT_MEDIA_TYPE,
} from '@lakka/contracts';
import type {
  ConversationSummaryView,
  ConversationView,
  InputSupport,
  PendingApprovalView,
  RequestableView,
} from '@lakka/contracts';
import { capShortLine, meterCaps, modelLabel, problemOf } from '../../../components/chat/copy.ts';
import type { ChatProblem } from '../../../components/chat/copy.ts';
import { Composer, MESSAGE_BOX_ID } from '../../../components/chat/composer.tsx';
import type { PendingFile } from '../../../components/chat/composer.tsx';
import { ConversationList, RenameDialog } from '../../../components/chat/conversation-list.tsx';
import { useFollowEnd } from '../../../components/chat/follow-end.ts';
import { ReplyView, Turn } from '../../../components/chat/message.tsx';
import { AUTO, choiceName, ModelPicker } from '../../../components/chat/model-picker.tsx';
import { keptReason, threadOf, toolLabel } from '../../../components/chat/thread.ts';
import type { Reply } from '../../../components/chat/thread.ts';
import { Icon } from '../../../components/icons.tsx';
import { BudgetMeter } from '../../../components/patterns/budget-meter.tsx';
import { ErrorNotice, InfoNote } from '../../../components/patterns/notices.tsx';
import {
  KeyApprovalNotice,
  ToolApprovalCard,
} from '../../../components/patterns/tool-approval.tsx';
import {
  CONVERSATIONS_HIDE,
  CONVERSATIONS_ID,
  CONVERSATIONS_SHOW,
  MenuButton,
  useShell,
} from '../../../components/shell/app-shell.tsx';
import { t } from '../../../i18n/index.ts';
import { api, ApiError } from '../../../lib/api.ts';
import { carriesFiles, isTextFile, pastedName, textDataUrl } from '../../../lib/attachments.ts';
import { usedUpCap } from '../../../lib/budget-meter.ts';
import { ChatError, streamChat } from '../../../lib/chat.ts';
import type {
  ChatApproval,
  ChatDecision,
  ChatErrorDetails,
  ChatPart,
  ChatToolActivity,
  ChatTurn,
} from '../../../lib/chat.ts';
import {
  contentCaptureQuery,
  conversationQuery,
  conversationsQuery,
  remainingBudgetQuery,
  requestableQuery,
  workspaceQuery,
} from '../../../lib/queries.ts';

/*
 * Chat (CH-1 to CH-5, CH-7, ADR 0061; docs/design/docs/screens.md, Chat), a client of
 * /v1/chat/completions like any other (G5): it sends the conversation's history and the new
 * message, and the api stores both (ADR 0060). The conversation is in the search string, so
 * starting one mid-send keeps this component, and the reply streaming into it, in place. Tools
 * run on the server; their calls and results come back with the stored conversation, and a call
 * that asks first waits for the person's answer there (TL-4, TL-5, ADR 0071).
 *
 * The page fills the space beside the side menu: the conversations, then main, "Chat", with the
 * header, the messages and the message box. On a phone the conversations move into the menu
 * drawer and the page brings its own top bar.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChatSearch {
  c?: string;
}

export const Route = createFileRoute('/_app/workspaces/$workspaceId_/chat')({
  staticData: { fullPage: true },
  validateSearch: (search: Record<string, unknown>): ChatSearch =>
    typeof search['c'] === 'string' && UUID.test(search['c']) ? { c: search['c'] } : {},
  loaderDeps: ({ search }) => ({ c: search.c }),
  loader: async ({ context, params, deps }) => {
    const { queryClient } = context;
    const workspace = await queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    if (workspace.role === null) return;
    await Promise.all([
      queryClient.ensureQueryData(conversationsQuery(params.workspaceId)),
      queryClient.ensureQueryData(requestableQuery(params.workspaceId)),
      queryClient.ensureQueryData(remainingBudgetQuery(params.workspaceId)),
      queryClient.ensureQueryData(contentCaptureQuery(params.workspaceId)),
    ]);
    if (deps.c === undefined) return;
    try {
      await queryClient.ensureQueryData(conversationQuery(params.workspaceId, deps.c));
    } catch (error) {
      // Deleted, or never ours: start afresh rather than show an error page.
      if (error instanceof ApiError && error.status === 404) {
        throw redirect({
          to: '/workspaces/$workspaceId/chat',
          params: { workspaceId: params.workspaceId },
          search: {},
        });
      }
      throw error;
    }
  },
  component: ChatPage,
});

function ChatPage() {
  const { workspaceId } = Route.useParams();
  const { c } = Route.useSearch();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { setDrawerExtra, setMenuOpen, conversationsHidden, toggleConversations } = useShell();
  const member = workspace.role !== null;

  // On a phone the conversations are in the menu drawer, right under Chat.
  useEffect(() => {
    if (!member) return undefined;
    setDrawerExtra(
      <ConversationList
        workspaceId={workspaceId}
        current={c ?? null}
        variant="drawer"
        onOpen={() => setMenuOpen(false)}
      />,
    );
    return () => setDrawerExtra(null);
  }, [member, workspaceId, c, setDrawerExtra, setMenuOpen]);

  return (
    <div className="flex h-full min-h-0">
      <a href={`#${MESSAGE_BOX_ID}`} className="lk-skip-link">
        {t('chat.skip')}
      </a>
      {member && (
        // Hidden rather than removed, so Show conversations always names a list that exists.
        // Its heading row is centred 32px from the top, on one line with the side menu's brand
        // row and the chat header, so the toggles line up whichever is collapsed.
        <div
          id={CONVERSATIONS_ID}
          className={`hidden w-(--lk-conversations-width) shrink-0 flex-col border-r border-border bg-surface px-3 pt-4 pb-3 ${
            conversationsHidden ? '' : 'lg:flex'
          }`}
        >
          <ConversationList
            workspaceId={workspaceId}
            current={c ?? null}
            variant="column"
            action={
              <Button
                id={CONVERSATIONS_HIDE}
                isIconOnly
                variant="ghost"
                aria-label={t('chat.hideConversations')}
                aria-expanded={true}
                aria-controls={CONVERSATIONS_ID}
                className="text-muted"
                onPress={toggleConversations}
              >
                <Icon name="conversationsHide" />
              </Button>
            }
          />
        </div>
      )}
      {member ? (
        <Conversation workspaceId={workspaceId} conversationId={c ?? null} />
      ) : (
        <main id="main" aria-label={t('chat.main')} className="flex grow flex-col gap-4 p-6">
          <div className="flex items-center gap-2 lg:hidden">
            <MenuButton />
          </div>
          <h1 className="lk-title">{t('chat.title', { workspace: workspace.name })}</h1>
          <InfoNote>{t('chat.membersOnly')}</InfoNote>
        </main>
      )}
    </div>
  );
}

/** A reply on its way: shown until the stored conversation has it (ADR 0060). */
interface Pending {
  conversationId: string;
  /** An answer to a tool call the conversation was waiting on, rather than a new message. */
  continuation: boolean;
  text: string;
  files: readonly PendingFile[];
  reply: string;
  decision: ChatDecision | null;
  tools: ChatToolActivity[];
  streaming: boolean;
}

/**
 * The turns to send: the stored history, without replies that never got a word out. Earlier
 * files go by id, since providers keep nothing between requests and uploading them again would
 * be slow (ADR 0062). Tool results stay out: they belonged to the run that called the tools, and
 * the reply that followed says what the model made of them (ADR 0071).
 */
function historyOf(conversation: ConversationView | undefined): ChatTurn[] {
  return (conversation?.messages ?? []).flatMap((m): ChatTurn[] => {
    if (m.role === 'tool') return [];
    if (m.attachments.length === 0) {
      return m.content === '' ? [] : [{ role: m.role, content: m.content }];
    }
    const parts: ChatPart[] = [
      ...(m.content === '' ? [] : [{ type: 'text' as const, text: m.content }]),
      ...m.attachments.map((a) => ({ type: 'file' as const, file: { file_id: a.id } })),
    ];
    return [{ role: m.role, content: parts }];
  });
}

const NO_INPUT: InputSupport = { images: false, pdf: false };

/** What the current choice reads (CH-5): auto, a route or a model. */
function supportFor(requestable: RequestableView, choice: string | null): InputSupport {
  if (choice === null) return requestable.auto;
  if (choice.startsWith('route/')) {
    const name = choice.slice('route/'.length);
    return requestable.routes.find((r) => r.name === name)?.input ?? NO_INPUT;
  }
  return requestable.models.find((m) => m.id === choice)?.input ?? NO_INPUT;
}

// Every model reads text: the gateway gives it a text file as text (ADR 0106).
const readsFile = (support: InputSupport, mediaType: string) =>
  mediaType === TEXT_MEDIA_TYPE ||
  (mediaType === 'application/pdf'
    ? support.pdf
    : mediaType.startsWith('image/') && support.images);

function kindsText(support: InputSupport): string {
  if (support.images && support.pdf) return t('chat.kind.all');
  if (support.images) return t('chat.kind.imagesAndText');
  return support.pdf ? t('chat.kind.pdfAndText') : t('chat.kind.text');
}

/**
 * Each picked file with what is wrong with it, if anything, for the model chosen now (CH-5):
 * a kind nothing here reads, a kind this model does not read, too large, or past what one
 * message may carry. Worked out on every render, so choosing another model updates the marks.
 */
function checked(
  files: readonly PendingFile[],
  support: InputSupport,
  model: string,
): PendingFile[] {
  let total = 0;
  return files.map((f) => {
    let problem: string | null = null;
    if (f.notText) problem = t('chat.file.notUtf8');
    else if (f.dataUrl === null) problem = t('chat.file.failed');
    else if (!(ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(f.mediaType)) {
      problem = t('chat.file.notReadable', { kinds: kindsText(support) });
    } else if (!readsFile(support, f.mediaType)) problem = t('chat.file.notForModel', { model });
    else if (f.size > MAX_ATTACHMENT_BYTES) problem = t('chat.file.tooLarge');
    else {
      total += f.size;
      if (total > MAX_MESSAGE_ATTACHMENT_BYTES) problem = t('chat.file.over');
    }
    return { ...f, problem };
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('unreadable')),
    );
    reader.addEventListener('error', () => reject(new Error('unreadable')));
    reader.readAsDataURL(file);
  });
}

/**
 * The new message in the OpenAI format: plain text, or text and files as parts. Images go as file
 * parts too, which carry the file name that image_url parts have no room for (ADR 0062).
 */
function contentOf(text: string, files: readonly PendingFile[]): string | ChatPart[] {
  if (files.length === 0) return text;
  return [
    ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    ...files.map((f): ChatPart => ({
      type: 'file',
      file: { file_data: f.dataUrl ?? '', filename: f.name },
    })),
  ];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits, briefly, until the stored conversation has the reply to `requestId`. The api stores it
 * as the stream ends, which can be a moment after the last byte reaches us.
 */
async function awaitStoredReply(
  queryClient: QueryClient,
  workspaceId: string,
  conversationId: string,
  requestId: string,
): Promise<void> {
  const query = conversationQuery(workspaceId, conversationId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
    const stored = queryClient.getQueryData(query.queryKey);
    // Any message will do: a run that stops again for approval stores a result, and no reply.
    if (stored?.messages.some((m) => m.role !== 'user' && m.requestId === requestId)) return;
    await sleep(250);
  }
}

/** Moves focus to the model picker that is showing, for "Pick another model". */
function focusPicker() {
  for (const id of ['model-picker', 'model-picker-bar']) {
    const trigger = document.getElementById(id);
    if (trigger !== null && trigger.offsetParent !== null) {
      trigger.focus();
      return;
    }
  }
}

function Conversation({
  workspaceId,
  conversationId,
}: {
  workspaceId: string;
  conversationId: string | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { conversationsHidden, toggleConversations } = useShell();
  const { data: conversation, isPending: loading } = useQuery({
    ...conversationQuery(workspaceId, conversationId ?? ''),
    enabled: conversationId !== null,
  });
  const { data: requestable } = useSuspenseQuery(requestableQuery(workspaceId));
  const { data: remaining } = useSuspenseQuery(remainingBudgetQuery(workspaceId));
  const { data: capture } = useSuspenseQuery(contentCaptureQuery(workspaceId));
  const [draftChoice, setDraftChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<
    (ChatProblem & { resend?: () => void; requestId?: string }) | null
  >(null);
  const [status, setStatus] = useState('');
  const [renaming, setRenaming] = useState(false);
  // Moves focus to an approval that appears after a send, not to one already waiting on load.
  const [asked, setAsked] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const { scroller, content, atEnd, follow, scrollToEnd } = useFollowEnd();
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  // A file dropped outside the conversation would make the browser open it and leave the page.
  useEffect(() => {
    const keep = (event: globalThis.DragEvent) => {
      if (event.dataTransfer !== null && carriesFiles([...event.dataTransfer.types])) {
        event.preventDefault();
      }
    };
    window.addEventListener('dragover', keep);
    window.addEventListener('drop', keep);
    return () => {
      window.removeEventListener('dragover', keep);
      window.removeEventListener('drop', keep);
    };
  }, []);

  const current = conversationId === null ? undefined : conversation;
  const choice = current === undefined ? draftChoice : current.modelChoice;
  const support = supportFor(requestable, choice);
  const chosenName = choiceName(requestable, choice);
  const shownFiles = checked(files, support, chosenName);
  const stored = current?.messages ?? [];
  const pendingRequest = pending?.decision?.requestId ?? '';
  // Hide the pending turn once the stored history has it, so it never shows twice. A tool loop
  // stores each round as it ends, so while the reply streams its stored rounds stay hidden.
  const shownPending =
    pending !== null &&
    pending.conversationId === conversationId &&
    (pending.streaming || !stored.some((m) => m.role !== 'user' && m.requestId === pendingRequest))
      ? pending
      : null;
  const messages =
    shownPending?.streaming === true
      ? stored.filter((m) => m.role === 'user' || m.requestId !== pendingRequest)
      : stored;
  const thread = threadOf(messages);
  const waiting = pending === null ? (current?.pendingApproval ?? null) : null;
  const filesPath = `/api/workspaces/${workspaceId}/conversations/${conversationId ?? ''}/attachments`;
  const isLoading = conversationId !== null && loading;

  // Opening a conversation shows its end, and follows it.
  useEffect(() => {
    follow();
  }, [conversationId, follow]);

  const changeChoice = useMutation({
    mutationFn: (modelChoice: string | null) =>
      api(`/api/workspaces/${workspaceId}/conversations/${conversationId ?? ''}`, {
        method: 'PATCH',
        body: { modelChoice },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] }),
    onError: async () => {
      setProblem(problemOf('model_choice', {}));
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] });
    },
  });

  function onChoice(value: string | null) {
    setProblem(null);
    if (conversationId === null) {
      setDraftChoice(value);
      return;
    }
    // Shown and used at once, so a message sent before the save lands still uses it.
    queryClient.setQueryData(conversationQuery(workspaceId, conversationId).queryKey, (old) =>
      old === undefined ? old : { ...old, modelChoice: value },
    );
    changeChoice.mutate(value);
  }

  /** Puts a message that was not sent back where the person wrote it. */
  function restore(message: string, attached: readonly PendingFile[]) {
    setText(message);
    setFiles([...attached]);
  }

  async function send(message: string, attached: readonly PendingFile[], approval?: ChatApproval) {
    setProblem(null);
    setStatus('');
    // What is sent, and its reply, are what the person wants to see.
    follow();
    let id = conversationId;
    const history = historyOf(current);
    try {
      if (id === null) {
        const { conversation: created } = await api<{ conversation: ConversationSummaryView }>(
          `/api/workspaces/${workspaceId}/conversations`,
          { method: 'POST', body: { modelChoice: draftChoice } },
        );
        id = created.id;
        queryClient.setQueryData(conversationQuery(workspaceId, id).queryKey, {
          ...created,
          messages: [],
          pendingApproval: null,
        });
        await navigate({
          to: '/workspaces/$workspaceId/chat',
          params: { workspaceId },
          search: { c: id },
          replace: true,
        });
      }
    } catch {
      restore(message, attached);
      setProblem(problemOf('network', {}));
      return;
    }
    const target = id;
    const abort = new AbortController();
    controller.current = abort;
    // Set from a callback, so TypeScript cannot follow it as a plain variable.
    const started: { decision: ChatDecision | null } = { decision: null };
    setPending({
      conversationId: target,
      continuation: approval !== undefined,
      text: message,
      files: attached,
      reply: '',
      decision: null,
      tools: [],
      streaming: true,
    });
    const again = () => void send(message, attached, approval);
    try {
      await streamChat({
        workspaceId,
        conversationId: target,
        model: choice ?? AUTO,
        // An answer continues the stored run; the api ignores all but the system messages.
        messages:
          approval === undefined
            ? [...history, { role: 'user', content: contentOf(message, attached) }]
            : history,
        ...(approval === undefined ? {} : { approval }),
        signal: abort.signal,
        onDecision: (d) => {
          started.decision = d;
          setPending((p) => (p === null ? p : { ...p, decision: d }));
        },
        onText: (piece) => setPending((p) => (p === null ? p : { ...p, reply: p.reply + piece })),
        onToolActivity: (activity) =>
          setPending((p) => (p === null ? p : { ...p, tools: [...p.tools, activity] })),
      });
      setStatus(t('chat.status.done'));
      setAsked(true);
    } catch (failure) {
      if (abort.signal.aborted) {
        setStatus(t('chat.status.stopped'));
      } else {
        const code = failure instanceof ChatError ? failure.code : 'network';
        const details: ChatErrorDetails = failure instanceof ChatError ? failure.details : {};
        const found = problemOf(code, details, {
          caps: remaining?.caps ?? [],
          ...(started.decision === null ? {} : { model: started.decision.model }),
        });
        setProblem({
          ...found,
          resend: again,
          ...(started.decision === null ? {} : { requestId: started.decision.requestId }),
        });
        // Refused before anything was sent: nothing was stored, so the message goes back.
        if (failure instanceof ChatError && !failure.started && approval === undefined) {
          restore(message, attached);
        }
      }
    } finally {
      controller.current = null;
      setPending((p) => (p === null ? p : { ...p, streaming: false }));
      if (started.decision !== null) {
        await awaitStoredReply(queryClient, workspaceId, target, started.decision.requestId);
      }
      setPending(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationQuery(workspaceId, target).queryKey,
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: conversationsQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: remainingBudgetQuery(workspaceId).queryKey }),
      ]);
    }
  }

  /** The person's answer to the call the conversation is waiting on (TL-4, TL-5). */
  function answer(approval: ChatApproval) {
    if (pending !== null) return;
    void send('', [], approval);
  }

  /** Sends the question a stopped reply answered, again. */
  function askAgain(requestId: string) {
    const turn = stored.find((m) => m.role === 'user' && m.requestId === requestId);
    if (turn !== undefined && pending === null) void send(turn.content, []);
  }

  function onSubmit() {
    const message = text.trim();
    if ((message === '' && files.length === 0) || pending !== null) return;
    if (shownFiles.some((f) => f.problem !== null)) return;
    const attached = files;
    setText('');
    setFiles([]);
    void send(message, attached);
  }

  /** Files from Attach files, a drop or a paste, read and checked as they come (CH-5). */
  async function onPick(list: readonly File[]) {
    const added: PendingFile[] = [];
    for (const [i, file] of list.entries()) {
      const name = file.name === '' ? t('chat.file.unnamed') : file.name;
      const asText = isTextFile(file);
      let dataUrl: string | null = null;
      let notText = false;
      try {
        if (asText) {
          // Sent as plain UTF-8 text, whatever kind of text it is (ADR 0106).
          const url = textDataUrl(new Uint8Array(await file.arrayBuffer()));
          if (url === undefined) notText = true;
          else dataUrl = url;
        } else {
          dataUrl = await readAsDataUrl(file);
        }
      } catch {
        // Marked as not readable in the list.
      }
      added.push({
        key: `${Date.now()}-${i}-${name}`,
        name,
        mediaType: asText ? TEXT_MEDIA_TYPE : file.type,
        size: file.size,
        dataUrl,
        notText,
        problem: null,
      });
    }
    setFiles((previous) => [...previous, ...added]);
  }

  /** A long paste becomes a text document with a name of its own (ADR 0106). */
  function onLongPaste(pasted: string) {
    const name = pastedName(
      files.map((f) => f.name),
      t('chat.file.pastedText'),
    );
    void onPick([new File([pasted], name, { type: TEXT_MEDIA_TYPE })]);
  }

  const title =
    current === undefined
      ? t('chat.newTitle')
      : current.title === ''
        ? t('chat.untitled')
        : current.title;

  const decision = shownPending?.decision ?? null;
  const pendingReply: Reply | null =
    shownPending === null
      ? null
      : {
          requestId: decision?.requestId ?? '',
          model: decision?.model ?? null,
          modelName:
            decision === null
              ? ''
              : (requestable.models.find((m) => m.id === decision.model)?.displayName ??
                modelLabel(decision.model)),
          decision: {
            rule: decision?.rule ?? null,
            route: decision?.route ?? null,
            confidence: decision?.confidence ?? null,
            reason:
              decision?.rule === 'sticky' && decision.route === null
                ? keptReason(thread)
                : (decision?.reason ?? null),
            fallbackFrom: decision?.fallbackFrom ?? null,
            fallbackFromName:
              decision?.fallbackFrom == null
                ? null
                : (requestable.models.find((m) => m.id === decision.fallbackFrom)?.displayName ??
                  null),
          },
          text: shownPending.reply,
          tools: [],
          state: 'complete',
          costMicroUsd: null,
        };

  const tightest =
    remaining === null ? undefined : remaining.caps.find((cap) => cap.scope === remaining.scope);
  const caps = remaining === null ? [] : meterCaps(remaining.caps);
  const shortLine = tightest === undefined ? undefined : capShortLine(tightest);
  const usedUp = usedUpCap(caps);
  const empty = thread.length === 0 && shownPending === null && waiting === null;

  // Files dropped anywhere on the conversation are attached, as Attach files would (CH-5). A
  // drag counts in and out of every element it crosses, so the depth says when it has left.
  const takesFiles = (event: DragEvent<HTMLElement>) =>
    pending === null && carriesFiles([...event.dataTransfer.types]);
  const dropTarget = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!takesFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDropping(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!takesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!takesFiles(event)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDropping(false);
      }
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      dragDepth.current = 0;
      setDropping(false);
      if (!takesFiles(event)) return;
      event.preventDefault();
      void onPick([...event.dataTransfer.files]);
    },
  };

  return (
    <main
      id="main"
      aria-label={t('chat.main')}
      aria-busy={isLoading}
      className="flex min-w-0 grow flex-col bg-surface"
      {...dropTarget}
    >
      {/*
       * From 1024px: 64px above its bottom border, so its row is centred 32px from the top, on
       * one line with the side menu's brand row and the conversation list's heading.
       */}
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-surface pr-2 pl-1 lg:h-(--lk-header-height) lg:gap-4 lg:px-6">
        <span className="lg:hidden">
          <MenuButton />
        </span>
        {conversationsHidden && (
          <span className="hidden shrink-0 items-center gap-1 lg:flex">
            <Button
              id={CONVERSATIONS_SHOW}
              isIconOnly
              variant="ghost"
              aria-label={t('chat.showConversations')}
              aria-expanded={false}
              aria-controls={CONVERSATIONS_ID}
              className="text-muted"
              onPress={toggleConversations}
            >
              <Icon name="conversationsShow" />
            </Button>
            <Link
              to="/workspaces/$workspaceId/chat"
              params={{ workspaceId }}
              aria-label={t('chat.newConversation')}
              className={`${buttonVariants({ variant: 'ghost', isIconOnly: true })} text-muted`}
            >
              <Icon name="plus" />
            </Link>
            <span aria-hidden="true" className="ml-1 h-5 w-px bg-border" />
          </span>
        )}
        <h1 className="min-w-0 truncate font-serif text-lg font-normal lg:text-xl">{title}</h1>
        {current !== undefined && (
          <Button
            isIconOnly
            variant="ghost"
            aria-label={t('chat.renameConversation')}
            className="hidden text-muted lg:inline-flex"
            onPress={() => setRenaming(true)}
          >
            <Icon name="pencil" />
          </Button>
        )}
        <span className="grow" />
        <span className="hidden lg:block">
          <ModelPicker
            id="model-picker"
            variant="header"
            requestable={requestable}
            choice={choice}
            onChange={onChoice}
            isDisabled={changeChoice.isPending}
          />
        </span>
        <span className="lg:hidden">
          <ModelPicker
            id="model-picker-bar"
            variant="bar"
            requestable={requestable}
            choice={choice}
            onChange={onChoice}
            isDisabled={changeChoice.isPending}
          />
        </span>
        {caps.length > 0 && (
          <span className="hidden lg:block">
            <BudgetMeter
              caps={caps}
              variant="header"
              {...(shortLine === undefined ? {} : { shortLine })}
            />
          </span>
        )}
      </header>
      {caps.length > 0 && (
        <div className="lg:hidden">
          <BudgetMeter
            caps={caps}
            variant="strip"
            {...(shortLine === undefined ? {} : { shortLine })}
          />
        </div>
      )}
      {capture.enabled && (
        <p className="flex shrink-0 items-start gap-2 border-b border-border bg-surface-secondary px-4 py-2 text-small lg:px-6">
          <Icon name="eye" className="mt-0.5 size-3.5 text-muted" />
          <span>
            <span className="hidden lg:inline">
              {t('chat.capture', { days: String(capture.retentionDays) })}{' '}
            </span>
            <span className="lg:hidden">
              {t('chat.capture.short', { days: String(capture.retentionDays) })}{' '}
            </span>
            <Link to="/workspaces/$workspaceId" params={{ workspaceId }} className="lk-link">
              <span className="hidden lg:inline">{t('chat.capture.link')}</span>
              <span className="lg:hidden">{t('chat.capture.linkShort')}</span>
            </Link>
          </span>
        </p>
      )}

      <div className="relative flex min-h-0 grow flex-col">
        {/* The thread fades out under the header, as drawn. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-1 h-14 bg-linear-to-b from-surface to-transparent"
        />
        <div ref={scroller} className="min-h-0 grow overflow-y-auto px-4 lg:px-6">
          {/* One 760px column for the messages and the message box, so their edges line up. */}
          <div ref={content} className="mx-auto flex w-full max-w-190 flex-col gap-6 py-5 lg:py-8">
            {isLoading ? (
              <>
                <div aria-hidden="true" className="flex flex-col gap-4">
                  <Skeleton className="ml-auto h-11 w-1/2 rounded-2xl" />
                  <Skeleton className="h-3 w-2/5 rounded" />
                  <Skeleton className="h-3 w-full rounded" />
                  <Skeleton className="h-3 w-4/5 rounded" />
                </div>
                <p className="sr-only">{t('chat.status.loading')}</p>
              </>
            ) : empty ? (
              <div className="flex flex-col gap-2 pt-10 lg:pt-20">
                <h2 className="text-dialog-title">{t('chat.emptyTitle')}</h2>
                <p className="text-body text-muted">
                  {requestable.routing.pinnedModel !== null
                    ? t('chat.emptyPinned', { model: requestable.routing.pinnedModel.name })
                    : requestable.routing.enabled
                      ? t('chat.emptyAuto')
                      : t('chat.emptyDefault')}
                </p>
                <p className="text-body text-muted">{t('chat.emptyVerify')}</p>
              </div>
            ) : (
              <ol aria-label={t('chat.messages')} className="flex flex-col gap-5 lg:gap-6">
                {thread.map((item) =>
                  item.kind === 'turn' ? (
                    <Turn
                      key={item.id}
                      text={item.text}
                      attachments={item.attachments}
                      filesPath={filesPath}
                    />
                  ) : (
                    <ReplyView
                      key={item.id}
                      reply={item.reply}
                      workspaceId={workspaceId}
                      onAskAgain={() => askAgain(item.reply.requestId)}
                      // The alert above the message box says it for the reply that just broke.
                      quiet={problem?.requestId === item.reply.requestId}
                    />
                  ),
                )}
                {shownPending !== null && !shownPending.continuation && (
                  <Turn
                    text={shownPending.text}
                    pendingFiles={shownPending.files}
                    filesPath={filesPath}
                  />
                )}
                {pendingReply !== null && shownPending !== null && (
                  <ReplyView
                    reply={pendingReply}
                    workspaceId={workspaceId}
                    streaming={shownPending.streaming}
                    liveTools={shownPending.tools.map((tool) => ({
                      callId: tool.callId,
                      name: toolLabel(tool.name),
                    }))}
                  />
                )}
                {waiting !== null && (
                  <li>
                    <Approval request={waiting} onAnswer={answer} focusOnMount={asked} />
                  </li>
                )}
              </ol>
            )}
          </div>
        </div>
        {/* Only away from the end. It goes once used, so focus moves on to the message box. */}
        {!atEnd && (
          <Button
            variant="tertiary"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-overlay"
            onPress={() => {
              scrollToEnd();
              document.getElementById(MESSAGE_BOX_ID)?.focus({ preventScroll: true });
            }}
          >
            <Icon name="chevronDown" />
            {t('chat.scrollToLatest')}
          </Button>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 pt-3 pb-3 lg:border-t-0 lg:px-6 lg:pb-4">
        <div className="mx-auto flex w-full max-w-190 flex-col gap-2">
          <p role="status" className="sr-only">
            {status}
          </p>
          {problem !== null && (
            <ErrorNotice
              title={problem.title}
              actions={[
                ...(problem.retry === true && problem.resend !== undefined
                  ? [
                      {
                        label: t('chat.tryAgain'),
                        primary: true,
                        onPress: () => {
                          const resend = problem.resend;
                          setText('');
                          setFiles([]);
                          resend?.();
                        },
                      },
                    ]
                  : []),
                ...(problem.pickAnother === true
                  ? [{ label: t('chat.pickAnother'), onPress: focusPicker }]
                  : []),
              ]}
            >
              {problem.body}
            </ErrorNotice>
          )}
          <Composer
            text={text}
            onText={setText}
            files={shownFiles}
            onPick={(list) => void onPick(list)}
            onLongPaste={onLongPaste}
            dropping={dropping}
            onRemove={(key) => setFiles((all) => all.filter((f) => f.key !== key))}
            onSubmit={onSubmit}
            onStop={() => controller.current?.abort()}
            streaming={pending?.streaming === true}
            busy={pending !== null}
            support={support}
            status={waiting !== null && waiting.yours ? t('chat.status.waitingTool') : ''}
            usedUp={usedUp === null ? null : t('chat.sendUsedUp', { cap: usedUp.cap.name })}
          />
        </div>
      </div>
      <RenameDialog
        workspaceId={workspaceId}
        conversation={renaming && current !== undefined ? current : null}
        onDone={() => setRenaming(false)}
      />
    </main>
  );
}

/**
 * A tool call the conversation is waiting on (TL-4, AC 18). Only the person whose request made
 * the call can answer it; a call one of their keys made is answered through that key.
 */
function Approval({
  request,
  onAnswer,
  focusOnMount,
}: {
  request: PendingApprovalView;
  onAnswer: (approval: ChatApproval) => void;
  focusOnMount: boolean;
}) {
  const tool = toolLabel(request.tool);
  if (!request.yours) {
    return <KeyApprovalNotice keyName={request.keyName ?? ''} tool={tool} />;
  }
  const server = request.tool.split('__')[0] ?? request.tool;
  return (
    <ToolApprovalCard
      tool={tool}
      source={t('chat.approval.source', { server })}
      args={Object.entries(request.arguments)
        .map(([key, v]) => `${key}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')}
      focusOnMount={focusOnMount}
      onAllowOnce={() => onAnswer({ id: request.id, answer: 'once' })}
      onAlwaysAllow={() => onAnswer({ id: request.id, answer: 'always' })}
      onDeny={() => onAnswer({ id: request.id, answer: 'deny' })}
    />
  );
}
