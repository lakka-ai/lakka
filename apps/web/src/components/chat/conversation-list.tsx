import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, buttonVariants, Dropdown, Input, Label, TextField } from '@heroui/react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { GridList, GridListHeader, GridListItem, GridListSection } from 'react-aria-components';
import type { Key, Selection } from 'react-aria-components';
import type { ConversationSummaryView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { conversationQuery, conversationsQuery } from '../../lib/queries.ts';
import { Icon } from '../icons.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { groupConversations } from './copy.ts';

/*
 * The conversation list (CH-1; docs/design/docs/accessibility.md, Chat): a nav named
 * Conversations with New conversation, then the conversations grouped by date. The list is one
 * tab stop, a react-aria grid list: arrow keys move, Enter opens, and each row's Options button
 * opens Rename and Delete. The open conversation is the list's selection.
 */

const title = (c: ConversationSummaryView) => (c.title === '' ? t('chat.untitled') : c.title);

export function ConversationList({
  workspaceId,
  current,
  variant,
  action,
  onOpen,
}: {
  workspaceId: string;
  current: string | null;
  variant: 'column' | 'drawer';
  /** Beside the column's heading: the button that hides the list. */
  action?: ReactNode;
  /** Called after a conversation or New conversation is opened, so the drawer can close. */
  onOpen?: () => void;
}) {
  const navigate = useNavigate();
  const { data: conversations } = useSuspenseQuery(conversationsQuery(workspaceId));
  const [renaming, setRenaming] = useState<ConversationSummaryView | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummaryView | null>(null);
  // Grouped against the time the list was read, which the server and the browser share.
  const groups = groupConversations(conversations, new Date());

  function open(id: string) {
    void navigate({
      to: '/workspaces/$workspaceId/chat',
      params: { workspaceId },
      search: { c: id },
    });
    onOpen?.();
  }

  function onSelectionChange(keys: Selection) {
    if (keys === 'all') return;
    const [key] = keys;
    if (key !== undefined) open(String(key));
  }

  // In the column the heading names the landmark and the list; the drawer has no heading.
  const headingId = useId();
  const named =
    variant === 'column'
      ? { 'aria-labelledby': headingId }
      : { 'aria-label': t('chat.conversations') };
  // A row is as tall as a main menu item beside it: 34px in the column, 44px in the drawer.
  const row = variant === 'column' ? 'min-h-8.5 px-2.5 text-body' : 'min-h-11 px-3 text-body';

  return (
    <nav
      {...named}
      className={
        variant === 'column'
          ? 'flex min-h-0 flex-col gap-3'
          : // In the drawer, between Chat and the other pages, set apart from both (ADR 0110).
            'flex flex-col gap-2 border-b border-border py-2.5'
      }
    >
      {variant === 'column' && (
        // 16px below the heading row, so New conversation starts 64px down, level with the side
        // menu's workspace switcher and the chat header's bottom edge.
        <div className="mb-1 flex items-center justify-between pl-1">
          <h2 id={headingId} className="text-heading">
            {t('chat.conversations')}
          </h2>
          {action}
        </div>
      )}
      {/* A link, since it goes to an address: it opens in a new tab too, and works before the
          page has hydrated. */}
      <Link
        to="/workspaces/$workspaceId/chat"
        params={{ workspaceId }}
        search={{}}
        className={`${buttonVariants({ variant: 'primary', size: 'lg', fullWidth: true })} justify-start gap-2`}
        onClick={onOpen}
      >
        <Icon name="plus" />
        {t('chat.newConversation')}
      </Link>
      {conversations.length === 0 ? (
        <p className="px-1 text-small text-muted">{t('chat.empty')}</p>
      ) : (
        <GridList
          {...named}
          selectionMode="single"
          selectionBehavior="replace"
          disallowEmptySelection
          selectedKeys={current === null ? [] : [current]}
          onSelectionChange={onSelectionChange}
          className="flex min-h-0 flex-col overflow-y-auto outline-none"
        >
          {groups.map((group) => (
            <GridListSection key={group.label} id={group.label} className="flex flex-col">
              <GridListHeader
                className={`text-caption font-semibold text-muted ${variant === 'column' ? 'px-2.5 pt-3.5 pb-1.5' : 'px-3 pt-2.5 pb-0.5'}`}
              >
                {group.label}
              </GridListHeader>
              {group.conversations.map((c) => (
                <GridListItem
                  key={c.id}
                  id={c.id}
                  textValue={title(c)}
                  className={`group flex cursor-pointer items-center gap-2 rounded-lg ${row} hover:bg-default lk-focus-inset data-[selected]:bg-surface-secondary data-[selected]:font-semibold`}
                >
                  <span className="min-w-0 grow truncate">{title(c)}</span>
                  <Dropdown>
                    <Button
                      isIconOnly
                      variant="ghost"
                      aria-label={t('chat.options', { title: title(c) })}
                      className={`shrink-0 text-muted ${c.id === current ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100'}`}
                    >
                      <Icon name="more" />
                    </Button>
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu
                        aria-label={t('chat.options', { title: title(c) })}
                        onAction={(key: Key) => {
                          if (key === 'rename') setRenaming(c);
                          if (key === 'delete') setDeleting(c);
                        }}
                      >
                        <Dropdown.Item id="rename" textValue={t('chat.rename')}>
                          <Label>{t('chat.rename')}</Label>
                        </Dropdown.Item>
                        <Dropdown.Item id="delete" textValue={t('chat.delete')} variant="danger">
                          <Label>{t('chat.delete')}</Label>
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </GridListItem>
              ))}
            </GridListSection>
          ))}
        </GridList>
      )}
      <RenameDialog
        workspaceId={workspaceId}
        conversation={renaming}
        onDone={() => setRenaming(null)}
      />
      <DeleteDialog
        workspaceId={workspaceId}
        conversation={deleting}
        isCurrent={deleting !== null && deleting.id === current}
        onDone={() => setDeleting(null)}
      />
    </nav>
  );
}

/** Rename, from the list or the conversation's header (CH-1). */
export function RenameDialog({
  workspaceId,
  conversation,
  onDone,
}: {
  workspaceId: string;
  conversation: ConversationSummaryView | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      api(`/api/workspaces/${workspaceId}/conversations/${id}`, {
        method: 'PATCH',
        body: { title: value },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] });
      onDone();
    },
  });
  return (
    <FormDialog
      isOpen={conversation !== null}
      onOpenChange={(open) => {
        if (!open) {
          rename.reset();
          onDone();
        }
      }}
      title={t('chat.rename.title')}
      submitLabel={t('common.save')}
      isSubmitting={rename.isPending}
      {...(rename.isError ? { error: { title: t('app.error') } } : {})}
      onSubmit={(form) => {
        if (conversation === null) return;
        rename.mutate({ id: conversation.id, value: String(form.get('title') ?? '').trim() });
      }}
    >
      <TextField name="title" isRequired defaultValue={conversation?.title ?? ''}>
        <Label>{t('chat.rename.label')}</Label>
        <Input maxLength={200} />
      </TextField>
    </FormDialog>
  );
}

function DeleteDialog({
  workspaceId,
  conversation,
  isCurrent,
  onDone,
}: {
  workspaceId: string;
  conversation: ConversationSummaryView | null;
  isCurrent: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/workspaces/${workspaceId}/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: async (_, id) => {
      onDone();
      if (isCurrent) {
        await navigate({
          to: '/workspaces/$workspaceId/chat',
          params: { workspaceId },
          search: {},
        });
      }
      queryClient.removeQueries({ queryKey: conversationQuery(workspaceId, id).queryKey });
      await queryClient.invalidateQueries({ queryKey: conversationsQuery(workspaceId).queryKey });
    },
  });
  return (
    <ConfirmDialog
      isOpen={conversation !== null}
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
      title={t('chat.delete.title')}
      confirmLabel={t('chat.delete.confirm')}
      isPending={remove.isPending}
      onConfirm={() => {
        if (conversation !== null) remove.mutate(conversation.id);
      }}
    >
      {remove.isError ? t('app.error') : t('chat.delete.body')}
    </ConfirmDialog>
  );
}
