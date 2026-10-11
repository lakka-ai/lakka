import { useId, useState } from 'react';
import type { Key } from 'react';
import { Button, buttonVariants, Dropdown, Label, SearchField } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreatedPasswordReset, UserAdminView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  findPeople,
  lastActiveWords,
  pageOf,
  PEOPLE_PER_PAGE,
  signInWords,
  workspacesLine,
} from '../../lib/admin.ts';
import { Icon } from '../icons.tsx';
import { EmptyList, Pager } from '../patterns/card-section.tsx';
import { ConfirmDialog, TypedConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, TwoLine } from '../patterns/data-table.tsx';
import { ErrorNotice, InfoNote } from '../patterns/notices.tsx';
import { SecretDialog } from '../patterns/secret-dialog.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';

/*
 * People (ID-3, ID-6, NF-P4; Admin and Phone-People boards). Everyone on the server, found by
 * name or email as you type, with a status line saying how many match, 20 to a page. Row
 * actions name the person; on a phone they collapse into one Actions menu per row. Your own
 * row offers only Export data: the api refuses to let you suspend or delete yourself. Suspend
 * applies at once and can be undone; Delete asks for the person's email; making someone an
 * instance admin, or no longer one, asks first. A password reset link is shown once, as other
 * one-time secrets are. Neither is drawn; they sit in a More actions menu at the end of the row,
 * so the row keeps the board's three buttons (ADR 0097, ADR 0098).
 */

type Confirm = { kind: 'delete' | 'grant' | 'revoke'; person: UserAdminView };

const exportPath = (person: UserAdminView) => `/api/users/${person.id}/export`;

/** Actions the board does not draw, kept in the row's More actions menu on a desktop. */
const IN_MORE: ReadonlySet<string> = new Set(['grant', 'revoke', 'reset']);

function PersonStatus({ status }: { status: UserAdminView['status'] }) {
  return status === 'active' ? (
    <StatusChip tone="success">{t('admin.people.active')}</StatusChip>
  ) : (
    <StatusChip tone="danger">{t('admin.people.suspended')}</StatusChip>
  );
}

export function PeopleList({ people, me }: { people: readonly UserAdminView[]; me: string }) {
  const tableId = useId();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const found = findPeople(people, query);
  const shown = pageOf(found, page, PEOPLE_PER_PAGE);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const suspend = useMutation({
    mutationFn: (v: { person: UserAdminView; action: 'suspend' | 'reactivate' }) =>
      api(`/api/users/${v.person.id}/${v.action}`, { method: 'POST', body: {} }),
    onSuccess: async (_r, v) => {
      await refresh();
      setStatus(
        t(v.action === 'suspend' ? 'admin.people.wasSuspended' : 'admin.people.wasReactivated', {
          name: v.person.displayName,
        }),
      );
    },
    onError: () => setProblem(t('app.error')),
  });
  const admin = useMutation({
    mutationFn: (v: { person: UserAdminView; isInstanceAdmin: boolean }) =>
      api(`/api/users/${v.person.id}/instance-admin`, {
        method: 'PUT',
        body: { isInstanceAdmin: v.isInstanceAdmin },
      }),
    onSuccess: async (_r, v) => {
      setConfirm(null);
      await refresh();
      setStatus(
        t(v.isInstanceAdmin ? 'admin.people.wasMadeAdmin' : 'admin.people.wasUnmadeAdmin', {
          name: v.person.displayName,
        }),
      );
    },
    onError: (e) => {
      setConfirm(null);
      setProblem(
        e instanceof ApiError && e.code === 'last_instance_admin'
          ? t('admin.people.lastAdmin')
          : t('app.error'),
      );
    },
  });
  const [resetLink, setResetLink] = useState<{
    person: UserAdminView;
    link: string;
    expiresAt: string;
  } | null>(null);
  const reset = useMutation({
    mutationFn: (person: UserAdminView) =>
      api<CreatedPasswordReset>(`/api/users/${person.id}/password-reset`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (created, person) =>
      setResetLink({
        person,
        // The token goes in the fragment, which browsers never send to a server (ADR 0098).
        link: `${window.location.origin}/reset#${created.token}`,
        expiresAt: created.expiresAt,
      }),
    onError: () => setProblem(t('app.error')),
  });
  const remove = useMutation({
    mutationFn: (person: UserAdminView) =>
      api(`/api/users/${person.id}`, {
        method: 'DELETE',
        body: { confirmEmail: person.email ?? '' },
      }),
    onSuccess: async (_r, person) => {
      setConfirm(null);
      await refresh();
      setStatus(t('admin.people.wasDeleted', { name: person.displayName }));
    },
    onError: (e, person) => {
      setConfirm(null);
      setProblem(
        e instanceof ApiError && e.code === 'last_workspace_admin'
          ? t('admin.people.onlyWorkspaceAdmin', { name: person.displayName })
          : t('app.error'),
      );
    },
  });

  function act(person: UserAdminView, action: Key) {
    setProblem(null);
    setStatus('');
    if (action === 'suspend' || action === 'reactivate') suspend.mutate({ person, action });
    else if (action === 'export') window.location.assign(exportPath(person));
    else if (action === 'reset') reset.mutate(person);
    else if (action === 'grant' || action === 'revoke' || action === 'delete') {
      setConfirm({ kind: action, person });
    }
  }

  /** The actions a row offers, in the board's order. */
  const actionsFor = (p: UserAdminView) =>
    p.id === me
      ? (['export'] as const)
      : ([
          p.status === 'active' ? 'suspend' : 'reactivate',
          'export',
          p.isInstanceAdmin ? 'revoke' : 'grant',
          'reset',
          'delete',
        ] as const);
  const actionLabel = (action: ReturnType<typeof actionsFor>[number]) =>
    ({
      suspend: t('admin.people.suspend'),
      reactivate: t('admin.people.reactivate'),
      export: t('admin.people.export'),
      grant: t('admin.people.makeAdmin'),
      revoke: t('admin.people.removeAdmin'),
      reset: t('admin.people.reset'),
      delete: t('admin.people.delete'),
    })[action];
  const actionName = (action: ReturnType<typeof actionsFor>[number], p: UserAdminView) =>
    ({
      suspend: t('admin.people.suspendFor', { name: p.displayName }),
      reactivate: t('admin.people.reactivateFor', { name: p.displayName }),
      export: t('admin.people.exportFor', { name: p.displayName }),
      grant: t('admin.people.makeAdminFor', { name: p.displayName }),
      revoke: t('admin.people.removeAdminFor', { name: p.displayName }),
      reset: t('admin.people.resetFor', { name: p.displayName }),
      delete: t('admin.people.deleteFor', { name: p.displayName }),
    })[action];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <SearchField
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPage(0);
          }}
          className="flex w-full max-w-80 flex-col gap-1"
        >
          <Label>{t('admin.people.find')}</Label>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t('admin.people.findPlaceholder')} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        {/* Read out as people type (accessibility.md); the table shows the result. */}
        <p role="status" className="sr-only">
          {query.trim() === ''
            ? ''
            : found.length === 1
              ? t('admin.people.matchOne')
              : t('admin.people.matches', { n: String(found.length) })}
        </p>
      </div>
      <InfoNote>{t('admin.people.note')}</InfoNote>
      {problem !== null && <ErrorNotice title={problem} />}
      <p role="status" className="sr-only">
        {status}
      </p>
      <h2 id={tableId} className="sr-only">
        {t('admin.people.tableName')}
      </h2>
      {shown.rows.length === 0 ? (
        <EmptyList>{t('admin.people.noMatch')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={tableId}
          name={t('admin.people.tableName')}
          framed
          columns={[
            {
              key: 'person',
              header: t('admin.people.col.person'),
              cell: (p: UserAdminView) => <TwoLine first={p.displayName} second={p.email ?? ''} />,
            },
            {
              // The instance role in a column of its own, worded as Role is on a workspace's members.
              key: 'role',
              header: t('admin.people.col.role'),
              cell: (p: UserAdminView) => (
                <StatusChip tone={p.isInstanceAdmin ? 'outline' : 'neutral'}>
                  {p.isInstanceAdmin ? t('admin.people.role.admin') : t('admin.people.role.member')}
                </StatusChip>
              ),
            },
            {
              key: 'workspaces',
              header: t('admin.people.col.workspaces'),
              cell: (p: UserAdminView) => (
                <span className="block min-w-48">{workspacesLine(p.workspaces)}</span>
              ),
            },
            {
              key: 'signIn',
              header: t('admin.people.col.signIn'),
              cell: (p: UserAdminView) => signInWords(p.signsInWith),
            },
            {
              key: 'active',
              header: t('admin.people.col.lastActive'),
              cell: (p: UserAdminView) => lastActiveWords(p.lastActiveAt),
            },
            {
              key: 'status',
              header: t('admin.people.col.status'),
              cell: (p: UserAdminView) => <PersonStatus status={p.status} />,
            },
            {
              key: 'actions',
              header: t('admin.people.col.actions'),
              cell: (p: UserAdminView) => (
                <>
                  <span className="hidden items-center justify-end gap-2 whitespace-nowrap md:flex">
                    {actionsFor(p)
                      .filter((action) => !IN_MORE.has(action))
                      .map((action) =>
                        action === 'export' ? (
                          <a
                            key={action}
                            href={exportPath(p)}
                            download
                            aria-label={actionName(action, p)}
                            className={buttonVariants({ variant: 'outline' })}
                          >
                            {actionLabel(action)}
                          </a>
                        ) : (
                          <Button
                            key={action}
                            variant={action === 'delete' ? 'ghost' : 'outline'}
                            className={action === 'delete' ? 'lk-danger-text' : ''}
                            aria-label={actionName(action, p)}
                            isPending={
                              (action === 'suspend' || action === 'reactivate') &&
                              suspend.isPending &&
                              suspend.variables.person.id === p.id
                            }
                            onPress={() => act(p, action)}
                          >
                            {actionLabel(action)}
                          </Button>
                        ),
                      )}
                    {p.id !== me && (
                      <Dropdown>
                        <Button
                          isIconOnly
                          variant="ghost"
                          aria-label={t('admin.people.moreFor', { name: p.displayName })}
                          className={`text-muted`}
                        >
                          <Icon name="more" />
                        </Button>
                        <Dropdown.Popover placement="bottom end">
                          <Dropdown.Menu
                            aria-label={t('admin.people.moreFor', { name: p.displayName })}
                            onAction={(key: Key) => act(p, key)}
                          >
                            {actionsFor(p)
                              .filter((action) => IN_MORE.has(action))
                              .map((action) => (
                                <Dropdown.Item
                                  key={action}
                                  id={action}
                                  textValue={actionName(action, p)}
                                >
                                  <Label>{actionName(action, p)}</Label>
                                </Dropdown.Item>
                              ))}
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>
                    )}
                  </span>
                  <span className="flex justify-end md:hidden">
                    <Dropdown>
                      <Button
                        isIconOnly
                        variant="ghost"
                        aria-label={t('admin.people.actionsFor', { name: p.displayName })}
                        className={`text-muted`}
                      >
                        <Icon name="more" />
                      </Button>
                      <Dropdown.Popover placement="bottom end">
                        <Dropdown.Menu
                          aria-label={t('admin.people.actionsFor', { name: p.displayName })}
                          onAction={(key: Key) => act(p, key)}
                        >
                          {actionsFor(p).map((action) => (
                            <Dropdown.Item
                              key={action}
                              id={action}
                              textValue={actionLabel(action)}
                              {...(action === 'delete' ? { variant: 'danger' as const } : {})}
                            >
                              <Label>{actionLabel(action)}</Label>
                            </Dropdown.Item>
                          ))}
                        </Dropdown.Menu>
                      </Dropdown.Popover>
                    </Dropdown>
                  </span>
                </>
              ),
            },
          ]}
          rows={shown.rows}
          rowKey={(p) => p.id}
        />
      )}
      <Pager
        from={shown.from}
        to={shown.to}
        total={shown.total}
        hasPrevious={shown.hasPrevious}
        hasNext={shown.hasNext}
        onPrevious={() => setPage(shown.page - 1)}
        onNext={() => setPage(shown.page + 1)}
      />
      <SecretDialog
        isOpen={resetLink !== null}
        onSaved={() => {
          if (resetLink !== null) {
            setStatus(t('admin.people.resetMade', { name: resetLink.person.displayName }));
          }
          setResetLink(null);
        }}
        title={t('admin.people.resetTitle', { name: resetLink?.person.displayName ?? '' })}
        warning={t('admin.people.resetWarning', {
          name: resetLink?.person.displayName ?? '',
          date: resetLink === null ? '' : formatDateTime(resetLink.expiresAt),
        })}
        label={t('admin.people.resetLabel')}
        secret={resetLink?.link ?? ''}
      />
      {confirm?.kind === 'delete' && (
        <TypedConfirmDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={t('admin.people.deleteTitle', { name: confirm.person.displayName })}
          confirmLabel={t('admin.people.deleteConfirm')}
          expected={confirm.person.email ?? ''}
          isPending={remove.isPending}
          onConfirm={() => remove.mutate(confirm.person)}
        >
          {t('admin.people.deleteBody', { name: confirm.person.displayName })}
        </TypedConfirmDialog>
      )}
      {(confirm?.kind === 'grant' || confirm?.kind === 'revoke') && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={t(
            confirm.kind === 'grant' ? 'admin.people.grantTitle' : 'admin.people.revokeTitle',
            { name: confirm.person.displayName },
          )}
          confirmLabel={t(
            confirm.kind === 'grant' ? 'admin.people.makeAdmin' : 'admin.people.removeAdmin',
          )}
          isPending={admin.isPending}
          onConfirm={() =>
            admin.mutate({ person: confirm.person, isInstanceAdmin: confirm.kind === 'grant' })
          }
        >
          {t(confirm.kind === 'grant' ? 'admin.people.grantBody' : 'admin.people.revokeBody', {
            name: confirm.person.displayName,
          })}
        </ConfirmDialog>
      )}
    </div>
  );
}
