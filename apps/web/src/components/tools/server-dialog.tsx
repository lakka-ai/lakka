import { useState } from 'react';
import { Description, Input, Label, RadioGroup, TextField } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MCP_SERVER_NAME } from '@lakka/contracts';
import type { McpServerView, McpToolSyncView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api, ApiError, notAllowedOrigin } from '../../lib/api.ts';
import { useAllowOrigin } from '../admin/tool-servers.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { WriteOnlyField } from '../patterns/fields.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { WarningNote } from '../patterns/notices.tsx';
import { CheckboxOption, RadioDetails, RadioOption } from '../patterns/settings.tsx';

/*
 * Add a tool server, and edit one (TL-1, TL-2, ADR 0067, ADR 0068; Tools-Add board). The options
 * are radio groups, and the fields for the chosen option come right after it in reading order.
 * A command on this server is for instance admins only, and signs in with nothing or a shared
 * credential. A shared credential shows what it means, and Add uses aria-disabled until the box
 * is ticked; the agreement is not stored. Add creates the server, sets the credential and syncs
 * its tools. Edit keeps the transport; Remove server sits bottom left and asks first.
 *
 * An address at an origin nobody allowed is refused (NF-S4, ADR 0117). An instance admin is
 * offered to allow it from the error, which then saves again; a workspace admin is told to ask
 * one.
 */

type Reach = 'streamable_http' | 'stdio';
type SignIn = 'none' | 'shared' | 'oauth';

/** A short name from a display name: "Jira Cloud" -> "jira-cloud". */
export function slugOf(display: string): string {
  return display
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/**
 * A command line as the api takes it: the program, then its arguments. Double quotes keep
 * spaces inside one argument.
 */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = [...line.trim().matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '');
  const [command = '', ...args] = parts;
  return { command, args };
}

const joinCommand = (server: McpServerView) =>
  [server.command ?? '', ...server.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');

const FAILURE: Readonly<Record<string, MessageKey>> = {
  not_connected: 'toolsPage.failure.not_connected',
  no_credential: 'toolsPage.failure.no_credential',
  unreachable: 'toolsPage.failure.unreachable',
  auth_failed: 'toolsPage.failure.auth_failed',
  not_allowed: 'toolsPage.failure.not_allowed',
  error: 'toolsPage.failure.error',
};

/** Why a sync failed, from our own code or the api's message. */
export function syncFailure(code: string | null): string {
  if (code === null) return '';
  return t(FAILURE[code] ?? 'toolsPage.failure.error');
}

interface SaveError {
  body: string;
  /** The origin an instance admin may allow from the error. */
  allow?: string;
}

function errorFor(e: unknown, instanceAdmin: boolean): SaveError {
  const origin = notAllowedOrigin(e);
  if (origin !== null) {
    return instanceAdmin
      ? { body: t('toolsPage.form.notAllowedAdmin', { origin }), allow: origin }
      : { body: t('toolsPage.form.notAllowedAsk', { origin }) };
  }
  if (e instanceof ApiError && e.code === 'mcp_server_exists') {
    return { body: t('toolsPage.form.taken') };
  }
  if (e instanceof ApiError && e.status === 400) return { body: e.message };
  return { body: t('app.error') };
}

export function ServerDialog({
  workspaceId,
  server,
  instanceAdmin,
  onClose,
  onDone,
}: {
  workspaceId: string;
  /** The server to edit, or null to add one. */
  server: McpServerView | null;
  instanceAdmin: boolean;
  onClose: () => void;
  /** What happened, for the page's status line. */
  onDone: (status: string) => void;
}) {
  const queryClient = useQueryClient();
  const [display, setDisplay] = useState(server?.displayNameSet === true ? server.displayName : '');
  const [slug, setSlug] = useState(server?.name ?? '');
  const [slugTouched, setSlugTouched] = useState(server !== null);
  const [reach, setReach] = useState<Reach>(server?.transport ?? 'streamable_http');
  const [url, setUrl] = useState(server?.url ?? '');
  const [commandLine, setCommandLine] = useState(server === null ? '' : joinCommand(server));
  const [signIn, setSignIn] = useState<SignIn>(server?.authMode ?? 'none');
  const [credential, setCredential] = useState('');
  const [env, setEnv] = useState(server?.credentialEnv ?? '');
  const [agreed, setAgreed] = useState(server?.authMode === 'shared');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<SaveError | null>(null);
  const allowOrigin = useAllowOrigin();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const path = `/api/workspaces/${workspaceId}/mcp-servers`;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'mcp-servers'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'tools'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'mcp-connections'] }),
    ]);
  const name = slugTouched ? slug : slugOf(display);
  const command = reach === 'stdio';

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      const shape =
        reach === 'stdio'
          ? {
              ...splitCommand(commandLine),
              ...(signIn === 'shared' ? { credentialEnv: env.trim() } : {}),
            }
          : { url: url.trim() };
      let saved: McpServerView;
      if (server === null) {
        saved = (
          await api<{ server: McpServerView }>(path, {
            method: 'POST',
            body: {
              transport: reach,
              name,
              ...(display.trim() === '' ? {} : { displayName: display.trim() }),
              authMode: signIn,
              ...shape,
            },
          })
        ).server;
      } else {
        saved = (
          await api<{ server: McpServerView }>(`${path}/${server.id}`, {
            method: 'PATCH',
            body: {
              name,
              displayName: display.trim() === '' ? null : display.trim(),
              authMode: signIn,
              ...(reach === 'stdio'
                ? {
                    ...splitCommand(commandLine),
                    credentialEnv: signIn === 'shared' ? env.trim() : null,
                  }
                : { url: url.trim() }),
            },
          })
        ).server;
      }
      if (signIn === 'shared' && credential !== '') {
        await api(`${path}/${saved.id}/credential`, {
          method: 'PUT',
          body: { secret: credential },
        });
      }
      if (signIn === 'oauth' && clientId.trim() !== '') {
        await api(`${path}/${saved.id}/oauth-client`, {
          method: 'PUT',
          body: {
            clientId: clientId.trim(),
            ...(clientSecret === '' ? {} : { clientSecret }),
          },
        });
      }
      if (server !== null) return '';
      // A new server's tools are synced at once, where there is something to sync with.
      try {
        const synced = await api<McpToolSyncView>(`${path}/${saved.id}/tools/sync`, {
          method: 'POST',
          body: {},
        });
        return t('toolsPage.synced.result', {
          server: saved.displayName,
          added: String(synced.added),
          updated: String(synced.updated),
          removed: String(synced.removed),
        });
      } catch (e) {
        const found = (
          await api<{ server: McpServerView }>(`${path}/${saved.id}`).catch(() => ({
            server: saved,
          }))
        ).server;
        return t('toolsPage.form.addedNotSynced', {
          reason: syncFailure(found.lastSync?.error ?? (e instanceof ApiError ? 'error' : null)),
        });
      }
    },
    onSuccess: async (status) => {
      await refresh();
      onDone(status);
      onClose();
    },
    onError: (e) => setError(errorFor(e, instanceAdmin)),
  });
  const remove = useMutation({
    mutationFn: () => api(`${path}/${server?.id ?? ''}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setConfirmRemove(false);
      await refresh();
      onClose();
    },
  });

  function submit() {
    setError(null);
    if (!MCP_SERVER_NAME.test(name)) {
      setError({ body: t('toolsPage.form.slugInvalid') });
      return;
    }
    save.mutate();
  }

  const blocked = signIn === 'shared' && !agreed ? t('toolsPage.form.agreeFirst') : undefined;
  return (
    <>
      <FormDialog
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={
          server === null
            ? t('toolsPage.form.addTitle')
            : t('toolsPage.form.editTitle', { server: server.displayName })
        }
        submitLabel={
          server === null ? t('toolsPage.form.submitAdd') : t('toolsPage.form.submitEdit')
        }
        onSubmit={submit}
        isSubmitting={save.isPending}
        {...(blocked === undefined ? {} : { blockedBy: blocked })}
        {...(error === null
          ? {}
          : {
              error: {
                title: t('toolsPage.form.failed'),
                body: error.body,
                ...(error.allow === undefined
                  ? {}
                  : {
                      actions: [
                        {
                          label: t('toolsPage.form.allowOrigin', { origin: error.allow }),
                          primary: true,
                          onPress: () =>
                            allowOrigin.mutate(error.allow ?? '', {
                              onSuccess: () => {
                                setError(null);
                                save.mutate();
                              },
                              onError: () => setError({ body: t('app.error') }),
                            }),
                        },
                      ],
                    }),
              },
            })}
        {...(server === null
          ? {}
          : {
              destructive: {
                label: t('toolsPage.form.remove'),
                onPress: () => setConfirmRemove(true),
              },
            })}
      >
        <TextField value={display} onChange={setDisplay}>
          <Label>{t('toolsPage.form.name')}</Label>
          <Input />
          <Description>{t('toolsPage.form.nameHelp')}</Description>
        </TextField>
        <TextField
          value={name}
          onChange={(v) => {
            setSlugTouched(true);
            setSlug(v);
          }}
          isRequired
        >
          <Label>{t('toolsPage.form.slug')}</Label>
          <Input className="font-mono" spellCheck={false} autoCapitalize="none" />
          <Description>
            {t('toolsPage.form.slugHelp', { slug: name === '' ? 'name' : name })}
          </Description>
        </TextField>

        <RadioGroup
          value={reach}
          onChange={(v) => {
            const next = v === 'stdio' ? 'stdio' : 'streamable_http';
            setReach(next);
            if (next === 'stdio' && signIn === 'oauth') setSignIn('none');
          }}
          isDisabled={server !== null}
          className="flex flex-col gap-2"
        >
          <Label>{t('toolsPage.form.reach')}</Label>
          {server !== null && <Description>{t('toolsPage.form.reachFixed')}</Description>}
          <RadioOption
            card
            value="streamable_http"
            label={t('toolsPage.form.http')}
            description={t('toolsPage.form.httpHelp')}
          />
          {reach === 'streamable_http' && (
            <RadioDetails>
              <TextField value={url} onChange={setUrl} type="url" isRequired>
                <Label>{t('toolsPage.form.url')}</Label>
                <Input placeholder="https://" spellCheck={false} />
                <Description>{t('toolsPage.form.urlHelp')}</Description>
              </TextField>
            </RadioDetails>
          )}
          <RadioOption
            card
            value="stdio"
            label={t('toolsPage.form.command')}
            description={t('toolsPage.form.commandHelp')}
            isDisabled={!instanceAdmin}
          />
          {command && (
            <RadioDetails>
              <TextField value={commandLine} onChange={setCommandLine} isRequired>
                <Label>{t('toolsPage.form.commandLine')}</Label>
                <Input className="font-mono" spellCheck={false} />
                <Description>{t('toolsPage.form.commandLineHelp')}</Description>
              </TextField>
            </RadioDetails>
          )}
        </RadioGroup>

        <RadioGroup
          value={signIn}
          onChange={(v) => setSignIn(v === 'shared' ? 'shared' : v === 'oauth' ? 'oauth' : 'none')}
          className="flex flex-col gap-2"
        >
          <Label>{t('toolsPage.form.signIn')}</Label>
          <RadioOption
            card
            value="none"
            label={t('toolsPage.form.none')}
            description={t('toolsPage.form.noneHelp')}
          />
          <RadioOption
            card
            value="shared"
            label={t('toolsPage.form.shared')}
            description={t('toolsPage.form.sharedHelp')}
          />
          {signIn === 'shared' && (
            <RadioDetails>
              <WarningNote>
                <p className="font-semibold">{t('toolsPage.form.sharedWarningTitle')}</p>
                <p>{t('toolsPage.form.sharedWarning')}</p>
              </WarningNote>
              <WriteOnlyField
                label={t('toolsPage.form.credential')}
                emptyPlaceholder={t('toolsPage.form.credentialPlaceholder')}
                emptyHelp={t('toolsPage.form.credentialHelp')}
                isSet={server?.hasSharedCredential === true}
                value={credential}
                onChange={setCredential}
                isRequired={server?.hasSharedCredential !== true}
              />
              {command && (
                <TextField value={env} onChange={setEnv} isRequired>
                  <Label>{t('toolsPage.form.env')}</Label>
                  <Input className="font-mono" spellCheck={false} placeholder="API_TOKEN" />
                  <Description>{t('toolsPage.form.envHelp')}</Description>
                </TextField>
              )}
              <CheckboxOption
                isSelected={agreed}
                onChange={setAgreed}
                label={t('toolsPage.form.agree')}
              />
            </RadioDetails>
          )}
          <RadioOption
            card
            value="oauth"
            label={t('toolsPage.form.oauth')}
            description={
              command ? t('toolsPage.form.oauthHttpOnly') : t('toolsPage.form.oauthHelp')
            }
            isDisabled={command}
          />
          {signIn === 'oauth' && (
            <RadioDetails>
              <TextField value={clientId} onChange={setClientId}>
                <Label>{t('toolsPage.form.oauthClient')}</Label>
                <Input spellCheck={false} />
              </TextField>
              <WriteOnlyField
                label={t('toolsPage.form.oauthSecret')}
                isSet={server?.oauthClient === 'admin'}
                value={clientSecret}
                onChange={setClientSecret}
              />
            </RadioDetails>
          )}
        </RadioGroup>
      </FormDialog>
      {server !== null && (
        <ConfirmDialog
          isOpen={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={t('toolsPage.form.removeTitle', { server: server.displayName })}
          confirmLabel={t('toolsPage.form.remove')}
          isPending={remove.isPending}
          onConfirm={() => remove.mutate()}
        >
          {t('toolsPage.form.removeBody')}
        </ConfirmDialog>
      )}
    </>
  );
}
