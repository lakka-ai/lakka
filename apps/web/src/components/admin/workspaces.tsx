import { useId, useRef, useState } from 'react';
import { Description, FieldError, Input, Label, ListBox, Select, TextField } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { CreateWorkspaceInput, UserAdminView, WorkspaceView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import type { WorkspaceSummary } from '../../lib/admin.ts';
import { formatDayAndYear } from '../../lib/format.ts';
import { formatMicroUsd } from '../../lib/money.ts';
import { slugFor } from '../../lib/slug.ts';
import { EmptyList } from '../patterns/card-section.tsx';
import { TypedConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, RowActions, useFocusTableOnClose } from '../patterns/data-table.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { ErrorNotice, InfoNote, WarningNote } from '../patterns/notices.tsx';

/*
 * Workspaces (ID-3; Admin-Workspaces and Admin-Workspace-Dialogs boards), for instance admins:
 * every workspace with its admins, people and spend this month, each name a link to its
 * Workspace settings. Create workspace and Rename open form dialogs with focus on Name, and a
 * status line says what changed. The name for links is made from the name, as in first-run
 * setup, and the first admin may be someone else (ADR 0102). Delete asks for the name typed
 * again, in an alertdialog whose button stays aria-disabled until it matches; afterwards focus
 * goes to the table, since the row it came from is gone (ID-8, ADR 0104).
 */

const refresh = (queryClient: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
    // People and spend name workspaces too.
    queryClient.invalidateQueries({ queryKey: ['users'] }),
    queryClient.invalidateQueries({ queryKey: ['spend'] }),
  ]);

export function WorkspacesList({
  rows,
  summary,
  status,
  onStatus,
}: {
  rows: readonly WorkspaceSummary[];
  /** "3 workspaces. 31 people in total, ... Spend matches Instance spend." */
  summary: string;
  /** What changed, for the status line under the note. */
  status: string;
  onStatus: (status: string) => void;
}) {
  const tableId = useId();
  const table = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<WorkspaceSummary | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceSummary | null>(null);
  const focusTableOnClose = useFocusTableOnClose(table, deleting !== null);
  return (
    <div className="flex flex-col gap-6">
      <InfoNote>{t('admin.workspaces.note')}</InfoNote>
      <p role="status" className="sr-only">
        {status}
      </p>
      <h2 id={tableId} className="sr-only">
        {t('admin.workspaces.tableName')}
      </h2>
      <div ref={table}>
        {rows.length === 0 ? (
          <EmptyList>{t('admin.workspaces.none')}</EmptyList>
        ) : (
          <DataTable
            labelledBy={tableId}
            name={t('admin.workspaces.tableName')}
            framed
            rows={rows}
            rowKey={(w) => w.id}
            columns={[
              {
                key: 'workspace',
                header: t('admin.workspaces.col.workspace'),
                cell: (w: WorkspaceSummary) => (
                  <Link
                    to="/workspaces/$workspaceId"
                    params={{ workspaceId: w.id }}
                    className="lk-link lk-link-alone font-medium"
                  >
                    {w.name}
                  </Link>
                ),
              },
              {
                key: 'admins',
                header: t('admin.workspaces.col.admins'),
                cell: (w: WorkspaceSummary) => (
                  <span className="block min-w-40 text-small">
                    {w.admins.length === 0 ? t('admin.workspaces.noAdmin') : w.admins.join(', ')}
                  </span>
                ),
              },
              {
                key: 'people',
                header: t('admin.workspaces.col.people'),
                numeric: true,
                cell: (w: WorkspaceSummary) => w.people.toLocaleString('en'),
              },
              {
                key: 'spent',
                header: t('admin.workspaces.col.spent'),
                numeric: true,
                cell: (w: WorkspaceSummary) => formatMicroUsd(w.spentMicroUsd),
              },
              {
                key: 'created',
                header: t('admin.workspaces.col.created'),
                cell: (w: WorkspaceSummary) => (
                  <span className="lk-num whitespace-nowrap">{formatDayAndYear(w.createdAt)}</span>
                ),
              },
              {
                key: 'actions',
                header: t('admin.workspaces.col.actions'),
                cell: (w: WorkspaceSummary) => (
                  <RowActions
                    name={w.name}
                    actions={[
                      {
                        id: 'rename',
                        label: t('admin.workspaces.rename'),
                        name: t('admin.workspaces.renameFor', { name: w.name }),
                        onAction: () => setRenaming(w),
                      },
                      {
                        id: 'delete',
                        label: t('admin.workspaces.delete'),
                        name: t('admin.workspaces.deleteFor', { name: w.name }),
                        danger: true,
                        onAction: () => setDeleting(w),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        )}
      </div>
      <p className="text-body text-muted">{summary}</p>
      {renaming !== null && (
        <RenameDialog
          workspace={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(name) => {
            setRenaming(null);
            onStatus(t('admin.workspaces.wasRenamed', { old: renaming.name, name }));
          }}
        />
      )}
      {deleting !== null && (
        <DeleteDialog
          workspace={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            onStatus(t('admin.workspaces.wasDeleted', { name: deleting.name }));
            // The row that opened the dialog is gone; the table is where to carry on.
            focusTableOnClose();
          }}
        />
      )}
    </div>
  );
}

function DeleteDialog({
  workspace,
  onClose,
  onDeleted,
}: {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/workspaces/${workspace.id}`, {
        method: 'DELETE',
        body: { confirmName: workspace.name },
      }),
    onSuccess: async () => {
      await refresh(queryClient);
      onDeleted();
    },
  });
  const name = workspace.name;
  return (
    <TypedConfirmDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('admin.workspaces.deleteTitle', { name })}
      confirmLabel={t('admin.workspaces.deleteConfirm')}
      expected={name}
      mismatch={t('admin.workspaces.deleteNoMatch')}
      isPending={remove.isPending}
      onConfirm={() => remove.mutate()}
    >
      <div className="flex flex-col gap-3">
        {remove.isError && <ErrorNotice title={t('app.error')} />}
        <WarningNote tone="danger">
          <p>{t('admin.workspaces.deleteRemoves', { name })}</p>
          <ul className="list-disc pl-4">
            <li>{t('admin.workspaces.deleteConversations')}</li>
            <li>{t('admin.workspaces.deleteKeys')}</li>
            <li>{t('admin.workspaces.deleteSetup')}</li>
          </ul>
          <p>
            {workspace.people === 0
              ? t('admin.workspaces.deleteSpend')
              : `${
                  workspace.people === 1
                    ? t('admin.workspaces.deleteKeepsOne')
                    : t('admin.workspaces.deleteKeeps', { n: String(workspace.people) })
                } ${t('admin.workspaces.deleteSpend')}`}
          </p>
        </WarningNote>
      </div>
    </TypedConfirmDialog>
  );
}

function RenameDialog({
  workspace,
  onClose,
  onRenamed,
}: {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const [empty, setEmpty] = useState(false);
  const rename = useMutation({
    mutationFn: (name: string) =>
      api<{ workspace: WorkspaceView }>(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        body: { name },
      }),
    onSuccess: async ({ workspace: renamed }) => {
      await refresh(queryClient);
      onRenamed(renamed.name);
    },
  });

  function submit(form: FormData) {
    const name = String(form.get('name') ?? '').trim();
    setEmpty(name === '');
    if (name === '') {
      focusName();
      return;
    }
    if (name === workspace.name) onClose();
    else rename.mutate(name);
  }

  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('admin.workspaces.renameTitle', { name: workspace.name })}
      submitLabel={t('admin.workspaces.saveName')}
      isSubmitting={rename.isPending}
      {...(rename.isError ? { error: { title: t('app.error') } } : {})}
      onSubmit={submit}
    >
      <NameField
        defaultValue={workspace.name}
        help="admin.workspaces.renameHelp"
        empty={empty}
        onEdit={() => setEmpty(false)}
      />
    </FormDialog>
  );
}

/** After the press that submitted, which keeps focus on the button until it ends. */
const focusName = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLInputElement>('[role=dialog] [name="name"]')?.focus(),
  );

function NameField({
  defaultValue,
  placeholder,
  help,
  empty,
  onEdit,
}: {
  defaultValue?: string;
  placeholder?: string;
  help: MessageKey;
  empty: boolean;
  /** Typing clears the problem the last submit found. */
  onEdit: () => void;
}) {
  return (
    <TextField
      name="name"
      isRequired
      validationBehavior="aria"
      isInvalid={empty}
      onChange={onEdit}
      maxLength={100}
      {...(defaultValue === undefined ? {} : { defaultValue })}
    >
      <Label>{t('admin.workspaces.name')}</Label>
      <Input autoComplete="off" {...(placeholder === undefined ? {} : { placeholder })} />
      {empty ? (
        <FieldError>{t('admin.workspaces.nameRequired')}</FieldError>
      ) : (
        <Description>{t(help)}</Description>
      )}
    </TextField>
  );
}

/** Active people, you first, for First admin. */
function adminChoices(people: readonly UserAdminView[], me: string) {
  const active = people.filter((p) => p.status === 'active');
  return [...active.filter((p) => p.id === me), ...active.filter((p) => p.id !== me)];
}

export function CreateWorkspaceDialog({
  isOpen,
  onOpenChange,
  people,
  me,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  people: readonly UserAdminView[];
  me: string;
  onCreated: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const [empty, setEmpty] = useState(false);
  const [admin, setAdmin] = useState(me);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateWorkspaceInput) =>
      api<{ workspace: WorkspaceView }>('/api/workspaces', { method: 'POST', body }),
    onSuccess: async ({ workspace }) => {
      await refresh(queryClient);
      onCreated(workspace.name);
    },
    onError: (e) =>
      setFailed(
        e instanceof ApiError && e.code === 'slug_taken'
          ? 'admin.workspaces.nameTaken'
          : 'app.error',
      ),
  });

  function open(next: boolean) {
    if (next) {
      setEmpty(false);
      setAdmin(me);
      setFailed(null);
      create.reset();
    }
    onOpenChange(next);
  }

  function submit(form: FormData) {
    setFailed(null);
    const name = String(form.get('name') ?? '').trim();
    setEmpty(name === '');
    if (name === '') {
      focusName();
      return;
    }
    create.mutate({
      name,
      slug: slugFor(name),
      ...(admin === me ? {} : { adminPrincipalId: admin }),
    });
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={open}
      title={t('admin.workspaces.createTitle')}
      submitLabel={t('admin.workspaces.create')}
      isSubmitting={create.isPending}
      {...(failed === null ? {} : { error: { title: t(failed) } })}
      onSubmit={submit}
    >
      <NameField
        placeholder={t('admin.workspaces.namePlaceholder')}
        help="admin.workspaces.nameHelp"
        empty={empty}
        onEdit={() => setEmpty(false)}
      />
      <Select
        value={admin}
        onChange={(key) => {
          if (typeof key === 'string') setAdmin(key);
        }}
      >
        <Label>{t('admin.workspaces.firstAdmin')}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Description>{t('admin.workspaces.firstAdminHelp')}</Description>
        <Select.Popover>
          <ListBox>
            {adminChoices(people, me).map((p) => {
              const label =
                p.id === me ? t('admin.workspaces.you', { name: p.displayName }) : p.displayName;
              return (
                <ListBox.Item key={p.id} id={p.id} textValue={label}>
                  {label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              );
            })}
          </ListBox>
        </Select.Popover>
      </Select>
    </FormDialog>
  );
}
