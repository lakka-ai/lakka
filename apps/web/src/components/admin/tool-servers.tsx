import { useId, useRef, useState } from 'react';
import { Description, FieldError, Input, Label, TextField } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { mcpAllowedOriginBody } from '@lakka/contracts';
import type { McpAllowedOriginView, McpAllowedOriginsView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { formatDayAndYear } from '../../lib/format.ts';
import { mcpOriginsQuery } from '../../lib/queries.ts';
import { CardSection, EmptyList } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, RowActions, useFocusTableOnClose } from '../patterns/data-table.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { ErrorNotice, InfoNote } from '../patterns/notices.tsx';

/*
 * Tool servers (NF-S4, ADR 0117; no board), for instance admins: the origins MCP servers, and the
 * sign-in services they name, may be at, for every workspace. It follows the Workspaces page: an
 * info note, a table with one row action, a status line that says what changed, Allow an origin
 * in the page header opening a form dialog, and Remove asking first, since the next request to
 * that origin is refused. Origins the operator set in LAKKA_MCP_PRIVATE_ORIGINS are listed
 * under their own heading, read-only, as they are changed only in the configuration.
 */

/** An origin to send: what the api takes, or null when it is not one. */
export function originInput(text: string): string | null {
  const parsed = mcpAllowedOriginBody.safeParse({ origin: text });
  return parsed.success ? parsed.data.origin : null;
}

/** Lists an origin, and refreshes what names it. Shared with the tool server dialog. */
export function useAllowOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (origin: string) =>
      api<{ allowlist: McpAllowedOriginsView }>('/api/admin/mcp-origins', {
        method: 'POST',
        body: { origin },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpOriginsQuery.queryKey }),
  });
}

export function AllowedOrigins({
  allowlist,
  status,
  onStatus,
}: {
  allowlist: McpAllowedOriginsView;
  /** What changed, for the status line under the note. */
  status: string;
  onStatus: (status: string) => void;
}) {
  const titleId = useId();
  const table = useRef<HTMLDivElement>(null);
  const [removing, setRemoving] = useState<McpAllowedOriginView | null>(null);
  const focusTableOnClose = useFocusTableOnClose(table, removing !== null);
  return (
    <div className="flex flex-col gap-6">
      <InfoNote>{t('admin.toolServers.note')}</InfoNote>
      <p role="status" className="sr-only">
        {status}
      </p>
      <CardSection
        title={t('admin.toolServers.listTitle')}
        subtitle={t('admin.toolServers.listHelp')}
        titleId={titleId}
        flush={allowlist.origins.length > 0}
      >
        <div ref={table}>
          {allowlist.origins.length === 0 ? (
            <EmptyList>{t('admin.toolServers.none')}</EmptyList>
          ) : (
            <DataTable
              labelledBy={titleId}
              name={t('admin.toolServers.listTitle')}
              rows={allowlist.origins}
              rowKey={(o) => o.origin}
              columns={[
                {
                  key: 'origin',
                  header: t('admin.toolServers.col.origin'),
                  cell: (o: McpAllowedOriginView) => (
                    <span className="font-mono break-all">{o.origin}</span>
                  ),
                },
                {
                  key: 'by',
                  header: t('admin.toolServers.col.by'),
                  cell: (o: McpAllowedOriginView) =>
                    o.source === 'upgrade'
                      ? t('admin.toolServers.byUpgrade')
                      : (o.addedBy ?? t('admin.toolServers.byUnknown')),
                },
                {
                  key: 'added',
                  header: t('admin.toolServers.col.added'),
                  cell: (o: McpAllowedOriginView) => (
                    <span className="lk-num whitespace-nowrap">
                      {formatDayAndYear(o.createdAt)}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: t('admin.toolServers.col.actions'),
                  cell: (o: McpAllowedOriginView) => (
                    <RowActions
                      name={o.origin}
                      actions={[
                        {
                          id: 'remove',
                          label: t('admin.toolServers.remove'),
                          name: t('admin.toolServers.removeFor', { origin: o.origin }),
                          danger: true,
                          onAction: () => setRemoving(o),
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          )}
        </div>
      </CardSection>
      {allowlist.configured.length > 0 && (
        <CardSection
          title={t('admin.toolServers.configuredTitle')}
          subtitle={t('admin.toolServers.configuredHelp')}
        >
          <ul className="flex flex-col gap-1">
            {allowlist.configured.map((origin) => (
              <li key={origin} className="font-mono text-body break-all">
                {origin}
              </li>
            ))}
          </ul>
        </CardSection>
      )}
      {removing !== null && (
        <RemoveOriginDialog
          origin={removing.origin}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            onStatus(t('admin.toolServers.wasRemoved', { origin: removing.origin }));
            // The row that opened the dialog is gone; the table is where to carry on.
            focusTableOnClose();
          }}
        />
      )}
    </div>
  );
}

function RemoveOriginDialog({
  origin,
  onClose,
  onRemoved,
}: {
  origin: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/admin/mcp-origins?origin=${encodeURIComponent(origin)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mcpOriginsQuery.queryKey });
      onRemoved();
    },
  });
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('admin.toolServers.removeTitle', { origin })}
      confirmLabel={t('admin.toolServers.removeConfirm')}
      isPending={remove.isPending}
      onConfirm={() => remove.mutate()}
    >
      <div className="flex flex-col gap-3">
        {remove.isError && <ErrorNotice title={t('app.error')} />}
        <p>{t('admin.toolServers.removeBody')}</p>
      </div>
    </ConfirmDialog>
  );
}

export function AllowOriginDialog({
  isOpen,
  onOpenChange,
  onAllowed,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAllowed: (origin: string) => void;
}) {
  const [wrong, setWrong] = useState(false);
  const allow = useAllowOrigin();

  function submit(form: FormData) {
    const origin = originInput(String(form.get('origin') ?? ''));
    setWrong(origin === null);
    if (origin === null) {
      // After the press that submitted, which keeps focus on the button until it ends.
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>('[role=dialog] [name="origin"]')?.focus(),
      );
      return;
    }
    allow.mutate(origin, {
      onSuccess: ({ allowlist }) => {
        // As the api wrote it: lowercase, without a default port.
        const listed = allowlist.origins.find((o) => o.origin === new URL(origin).origin)?.origin;
        onAllowed(listed ?? origin);
      },
    });
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setWrong(false);
          allow.reset();
        }
        onOpenChange(open);
      }}
      title={t('admin.toolServers.allowTitle')}
      submitLabel={t('admin.toolServers.allowConfirm')}
      isSubmitting={allow.isPending}
      {...(allow.isError ? { error: { title: t('app.error') } } : {})}
      onSubmit={submit}
    >
      <TextField
        name="origin"
        isRequired
        validationBehavior="aria"
        isInvalid={wrong}
        onChange={() => setWrong(false)}
        maxLength={255}
      >
        <Label>{t('admin.toolServers.origin')}</Label>
        <Input
          className="font-mono"
          placeholder="https://"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
        />
        {wrong ? (
          <FieldError>{t('admin.toolServers.originWrong')}</FieldError>
        ) : (
          <Description>{t('admin.toolServers.originHelp')}</Description>
        )}
      </TextField>
    </FormDialog>
  );
}
