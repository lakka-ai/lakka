import { useEffect, useId, useRef, useState } from 'react';
import { Button, Description, Label, TextArea, TextField, Input } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_THRESHOLD_DOWN,
  DEFAULT_THRESHOLD_UP,
  MAX_FALLBACKS,
  RECOMMENDED_ROUTE_EXAMPLES,
  ROUTE_NAME_PATTERN,
  ROUTING_SIGNALS,
} from '@lakka/contracts';
import type {
  ModelView,
  RouteBody,
  RouteView,
  RoutingPolicyView,
  RoutingSignal,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import {
  appliesDown,
  candidateExampleLine,
  costDirection,
  exampleLines,
  mostlyKeywords,
  moved,
  parseThreshold,
  routeStatus,
  withExampleLine,
  withoutExampleLine,
} from '../../lib/routing.ts';
import type { CostDirection, RouteStatus } from '../../lib/routing.ts';
import { routeLabel } from '../chat/copy.ts';
import { Icon } from '../icons.tsx';
import { ModelSelect } from '../model-select.tsx';
import { CardSection } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable } from '../patterns/data-table.tsx';
import { UnitField } from '../patterns/fields.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { WarningNote } from '../patterns/notices.tsx';
import { CheckboxOption } from '../patterns/settings.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';
import type { Tone } from '../patterns/status-chip.tsx';

/*
 * Routes (RT-1, RT-2, RT-5; Routing board, Routes; Routing-Edit board; accessibility.md,
 * Routing). The table lists every route with its model, how that compares with the default,
 * its examples and signals; Edit buttons are named for the route. Add a route and Edit open one
 * dialog, which starts on Name. Fallbacks are ordered with Move up and Move down buttons, never
 * by dragging: focus stays on the moved item and a status line says where it went. The example
 * count is a polite status, updated at most once a second. A signal another route owns is shown
 * disabled with that route's name. Delete route asks first.
 *
 * Routing picks the closest route when it is sure enough, with two thresholds per route (RT-5,
 * ADR 0045): which one applies depends on whether the route's model is cheaper than the
 * default, and the dialog says which applies now (ADR 0094).
 */

const COST: Readonly<Record<CostDirection, MessageKey>> = {
  same: 'routing.cost.same',
  down: 'routing.cost.down',
  up: 'routing.cost.up',
  unknown: 'routing.cost.unknown',
};

const STATUS: Readonly<Record<RouteStatus, { word: MessageKey; tone: Tone }>> = {
  on: { word: 'routing.status.on', tone: 'success' },
  needsExamples: { word: 'routing.status.needsExamples', tone: 'warning' },
  off: { word: 'routing.status.off', tone: 'neutral' },
};

const nameOf = (models: readonly ModelView[], ref: string) =>
  models.find((m) => m.id === ref)?.displayName ?? ref;

export function RoutesCard({
  workspaceId,
  policy,
  models,
}: {
  workspaceId: string;
  policy: RoutingPolicyView;
  models: readonly ModelView[];
}) {
  const titleId = useId();
  const [editing, setEditing] = useState<RouteView | 'new' | null>(null);
  const defaultModel = policy.settings.defaultModel;
  const add = (
    <Button size="lg" variant="primary" onPress={() => setEditing('new')}>
      <Icon name="plus" />
      {t('routing.routes.add')}
    </Button>
  );
  return (
    <>
      {policy.routes.length === 0 ? (
        // Empty, the section keeps a card's heading, as the sections that list tools and
        // approvals do; the button follows the sentence that says why.
        <CardSection title={t('routing.routes.emptyTitle')} titleId={titleId}>
          <div className="flex flex-col items-start gap-3">
            <p className="max-w-2xl text-small text-muted">
              {defaultModel === null
                ? t('routing.routes.emptyNoDefault')
                : t('routing.routes.empty', { model: nameOf(models, defaultModel) })}
            </p>
            {add}
          </div>
        </CardSection>
      ) : (
        <CardSection
          title={t('routing.routes.title')}
          subtitle={t('routing.routes.subtitle')}
          titleId={titleId}
          actions={add}
          flush
        >
          <DataTable
            labelledBy={titleId}
            name={t('routing.routes.title')}
            columns={[
              {
                key: 'route',
                header: t('routing.col.route'),
                cell: (r: RouteView) => <span className="font-semibold">{routeLabel(r.name)}</span>,
              },
              {
                key: 'model',
                header: t('routing.col.model'),
                cell: (r: RouteView) => nameOf(models, r.model),
              },
              {
                key: 'cost',
                header: t('routing.col.cost'),
                cell: (r: RouteView) => {
                  const d = costDirection(r.model, defaultModel, models);
                  return d === 'down' ? (
                    <StatusChip tone="success">{t(COST[d])}</StatusChip>
                  ) : (
                    <span className="text-muted">{t(COST[d])}</span>
                  );
                },
              },
              {
                key: 'examples',
                header: t('routing.col.examples'),
                numeric: true,
                cell: (r: RouteView) =>
                  r.examples.length < RECOMMENDED_ROUTE_EXAMPLES ? (
                    <span className="inline-flex items-center gap-1 text-warning-soft-foreground">
                      <Icon name="warning" className="size-3.5" />
                      <span aria-hidden="true">{r.examples.length}</span>
                      <span className="sr-only">
                        {t('routing.examples.few', { n: String(r.examples.length) })}
                      </span>
                    </span>
                  ) : (
                    r.examples.length
                  ),
              },
              {
                key: 'signals',
                header: t('routing.col.signals'),
                cell: (r: RouteView) =>
                  r.signals.length === 0 ? (
                    <span className="text-muted">{t('routing.none')}</span>
                  ) : (
                    <span className="flex flex-wrap gap-1.5">
                      {r.signals.map((s) => (
                        <StatusChip key={s} tone="neutral">
                          {t(`routing.signal.${s}`)}
                        </StatusChip>
                      ))}
                    </span>
                  ),
              },
              {
                key: 'status',
                header: t('routing.col.status'),
                cell: (r: RouteView) => {
                  const status = STATUS[routeStatus(r)];
                  return <StatusChip tone={status.tone}>{t(status.word)}</StatusChip>;
                },
              },
              {
                key: 'actions',
                header: t('routing.col.actions'),
                cell: (r: RouteView) => (
                  <Button
                    variant="outline"
                    aria-label={t('routing.editRoute', { name: routeLabel(r.name) })}
                    onPress={() => setEditing(r)}
                  >
                    {t('routing.edit')}
                  </Button>
                ),
              },
            ]}
            rows={policy.routes}
            rowKey={(r) => r.id}
          />
        </CardSection>
      )}
      {editing !== null && (
        <RouteDialog
          key={editing === 'new' ? 'new' : editing.id}
          workspaceId={workspaceId}
          route={editing === 'new' ? null : editing}
          policy={policy}
          models={models}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** The example count, said at most once a second while typing (accessibility.md, Routing). */
function useThrottled(value: string, ms: number): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now());
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

function countLine(n: number): string {
  if (n >= RECOMMENDED_ROUTE_EXAMPLES) return t('routing.form.examplesEnough', { n: String(n) });
  return n === 1 ? t('routing.form.examplesOne') : t('routing.form.examplesFew', { n: String(n) });
}

/** The count, then a warning when the examples are keywords rather than messages (RT-2). */
function examplesLine(lines: readonly string[]): string {
  const count = countLine(lines.length);
  return mostlyKeywords(lines) ? `${count} ${t('routing.form.examplesKeywords')}` : count;
}

function errorFor(e: unknown): string {
  if (e instanceof ApiError && e.code === 'route_exists') return t('routing.form.taken');
  if (e instanceof ApiError && e.code === 'candidate_gone') return t('routing.form.candidateGone');
  if (e instanceof ApiError && e.code === 'signal_claimed') return t('routing.form.signalTaken');
  if (e instanceof ApiError && e.status === 400) return e.message;
  return t('app.error');
}

/** A message an admin is adding as an example (RT-10, ADR 0114). */
export interface InitialExample {
  /** The candidate's message, which the save marks added. */
  messageId: string;
  text: string;
}

/**
 * Add a route and Edit route. Opened from a route example candidate (ADR 0114), it starts with
 * the message as the last example line, focused there, with a note that the admin should edit it
 * and that an example outlives the recorded text. Saving marks the candidate added; if it went
 * meanwhile, nothing is saved and the line comes out again unless the admin changed it.
 */
export function RouteDialog({
  workspaceId,
  route,
  policy,
  models,
  onClose,
  initialExample,
  initialModel,
}: {
  workspaceId: string;
  route: RouteView | null;
  policy: RoutingPolicyView;
  models: readonly ModelView[];
  onClose: () => void;
  initialExample?: InitialExample;
  /** For a new route: the model it starts with. */
  initialModel?: string;
}) {
  const queryClient = useQueryClient();
  const candidateLine =
    initialExample === undefined ? null : candidateExampleLine(initialExample.text);
  const [name, setName] = useState(route?.name ?? '');
  const [description, setDescription] = useState(route?.description ?? '');
  const [model, setModel] = useState<string | null>(route?.model ?? initialModel ?? null);
  const [fallbacks, setFallbacks] = useState<string[]>(route?.fallbacks ?? []);
  const [adding, setAdding] = useState<string | null>(null);
  const [crossProvider, setCrossProvider] = useState(route?.allowCrossProvider ?? false);
  const [examples, setExamples] = useState(() => {
    const typed = (route?.examples ?? []).join('\n');
    return candidateLine === null ? typed : withExampleLine(typed, candidateLine);
  });
  const [fromCandidates, setFromCandidates] = useState<string[]>(
    initialExample === undefined ? [] : [initialExample.messageId],
  );
  const [signals, setSignals] = useState<RoutingSignal[]>(route?.signals ?? []);
  const [down, setDown] = useState(String(route?.thresholdDown ?? DEFAULT_THRESHOLD_DOWN));
  const [up, setUp] = useState(String(route?.thresholdUp ?? DEFAULT_THRESHOLD_UP));
  const [enabled, setEnabled] = useState(route?.enabled ?? true);
  const [moveStatus, setMoveStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const noticeId = useId();
  const lines = exampleLines(examples);
  const examplesWeak = lines.length < RECOMMENDED_ROUTE_EXAMPLES || mostlyKeywords(lines);
  const lineCount = useThrottled(examplesLine(lines), 1000);
  const direction =
    model === null ? 'unknown' : costDirection(model, policy.settings.defaultModel, models);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'routing'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'requestable'] }),
    ]);

  const save = useMutation({
    mutationFn: (body: RouteBody) =>
      route === null
        ? api(`/api/workspaces/${workspaceId}/routes`, { method: 'POST', body })
        : api(`/api/workspaces/${workspaceId}/routes/${route.id}`, { method: 'PUT', body }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: (e) => {
      setError(errorFor(e));
      if (e instanceof ApiError && e.code === 'candidate_gone') {
        // The message is no longer offered: an unedited line goes with it, an edited one is the
        // admin's own words now.
        setFromCandidates([]);
        if (candidateLine !== null) setExamples((text) => withoutExampleLine(text, candidateLine));
      }
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/workspaces/${workspaceId}/routes/${route?.id ?? ''}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setConfirmDelete(false);
      await refresh();
      onClose();
    },
  });

  function move(index: number, delta: -1 | 1) {
    const next = moved(fallbacks, index, delta);
    setFallbacks(next);
    const item = fallbacks[index] ?? '';
    setMoveStatus(
      t('routing.form.moved', {
        model: nameOf(models, item),
        n: String(index + delta + 1),
        total: String(next.length),
      }),
    );
    // Focus stays on the moved item, on the same button if it can still move that way.
    requestAnimationFrame(() => {
      const row = listRef.current?.children[index + delta];
      const same = row?.querySelector<HTMLButtonElement>(
        `[data-move="${delta === -1 ? 'up' : 'down'}"]:not([disabled])`,
      );
      (same ?? row?.querySelector<HTMLButtonElement>('button:not([disabled])'))?.focus();
    });
  }

  function submit() {
    setError(null);
    const trimmed = name.trim();
    if (!ROUTE_NAME_PATTERN.test(trimmed)) {
      setNameInvalid(true);
      return;
    }
    setNameInvalid(false);
    if (model === null) {
      setError(t('routing.form.noModel'));
      return;
    }
    const thresholdDown = parseThreshold(down);
    const thresholdUp = parseThreshold(up);
    if (thresholdDown === undefined || thresholdUp === undefined) {
      setError(t('routing.form.thresholdInvalid'));
      return;
    }
    save.mutate({
      name: trimmed,
      description: description.trim(),
      model,
      fallbacks,
      allowCrossProvider: crossProvider,
      thresholdDown,
      thresholdUp,
      enabled,
      signals,
      examples: exampleLines(examples),
      ...(fromCandidates.length === 0 ? {} : { fromCandidates }),
    });
  }

  const owner = (signal: RoutingSignal) =>
    policy.routes.find((r) => r.id !== route?.id && r.signals.includes(signal));
  const downNow = appliesDown(direction);

  return (
    <>
      <FormDialog
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={route === null ? t('routing.form.addTitle') : t('routing.form.editTitle')}
        submitLabel={t('routing.form.save')}
        onSubmit={submit}
        isSubmitting={save.isPending}
        {...(candidateLine === null ? {} : { initialFocus: '[data-examples]' })}
        {...(error === null ? {} : { error: { title: t('routing.form.failed'), body: error } })}
        {...(route === null
          ? {}
          : {
              destructive: {
                label: t('routing.form.delete'),
                onPress: () => setConfirmDelete(true),
              },
            })}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField value={name} onChange={setName} isInvalid={nameInvalid} isRequired>
            <Label>{t('routing.form.name')}</Label>
            <Input spellCheck={false} autoCapitalize="none" className="font-mono" />
            <Description>
              {nameInvalid
                ? t('routing.form.nameInvalid')
                : ROUTE_NAME_PATTERN.test(name.trim())
                  ? t('routing.form.nameHelp', {
                      label: routeLabel(name.trim()),
                      name: name.trim(),
                    })
                  : t('routing.form.nameHelpEmpty')}
            </Description>
          </TextField>
          <ModelSelect
            label={t('routing.form.model')}
            {...(model === null
              ? {}
              : {
                  description:
                    direction === 'down'
                      ? t('routing.form.modelDown')
                      : direction === 'same' && model === policy.settings.defaultModel
                        ? t('routing.form.modelSame')
                        : t('routing.form.modelUp'),
                })}
            models={models}
            value={model}
            onChange={setModel}
            isRequired
          />
        </div>

        {/* Scored from while the route has no examples (RT-12, ADR 0122). */}
        <TextField value={description} onChange={setDescription}>
          <Label>{t('routing.form.description')}</Label>
          <TextArea rows={2} maxLength={500} className="px-3 py-2.5" />
          <Description>{t('routing.form.descriptionHelp')}</Description>
        </TextField>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-label">{t('routing.form.fallbacks')}</legend>
          <p className="text-small text-muted">{t('routing.form.fallbacksHelp')}</p>
          {fallbacks.length > 0 && (
            <ol ref={listRef} className="flex flex-col gap-2">
              {fallbacks.map((f, i) => (
                <li
                  key={f}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-1.5"
                >
                  <span className="lk-num w-4 text-small text-muted">{i + 1}</span>
                  <span className="min-w-0 grow truncate text-body">{nameOf(models, f)}</span>
                  <Button
                    isIconOnly
                    variant="ghost"
                    data-move="up"
                    isDisabled={i === 0}
                    aria-label={t('routing.form.moveUp', { model: nameOf(models, f) })}
                    onPress={() => move(i, -1)}
                  >
                    <Icon name="chevronDown" className="size-(--lk-icon) rotate-180" />
                  </Button>
                  <Button
                    isIconOnly
                    variant="ghost"
                    data-move="down"
                    isDisabled={i === fallbacks.length - 1}
                    aria-label={t('routing.form.moveDown', { model: nameOf(models, f) })}
                    onPress={() => move(i, 1)}
                  >
                    <Icon name="chevronDown" />
                  </Button>
                  <Button
                    isIconOnly
                    variant="ghost"
                    aria-label={t('routing.form.removeFallback', { model: nameOf(models, f) })}
                    onPress={() => setFallbacks((list) => list.filter((x) => x !== f))}
                  >
                    <Icon name="close" />
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <p role="status" className="sr-only">
            {moveStatus}
          </p>
          {fallbacks.length < MAX_FALLBACKS ? (
            <div className="flex flex-wrap items-end gap-2">
              <ModelSelect
                label={t('routing.form.fallbackToAdd')}
                models={models}
                value={adding}
                onChange={setAdding}
                exclude={[...(model === null ? [] : [model]), ...fallbacks]}
                className="min-w-56 [&>[data-slot=label]]:sr-only"
              />
              <Button
                size="lg"
                variant="outline"
                isDisabled={adding === null}
                onPress={() => {
                  if (adding === null) return;
                  setFallbacks((list) => [...list, adding]);
                  setAdding(null);
                }}
              >
                <Icon name="plus" />
                {t('routing.form.addFallback')}
              </Button>
            </div>
          ) : (
            <p className="text-small text-muted">{t('routing.form.fallbacksFull')}</p>
          )}
          <CheckboxOption
            isSelected={crossProvider}
            onChange={setCrossProvider}
            className="mt-1"
            label={t('routing.form.crossProvider')}
            description={t('routing.form.crossProviderHelp')}
          />
        </fieldset>

        {fromCandidates.length > 0 && (
          <WarningNote id={noticeId}>
            <p>{t('routing.form.candidateNotice')}</p>
          </WarningNote>
        )}
        <TextField value={examples} onChange={setExamples}>
          <Label>{t('routing.form.examples')}</Label>
          <TextArea
            rows={7}
            className="min-h-44.5 px-3 py-2.5"
            data-examples
            {...(fromCandidates.length > 0 ? { 'aria-describedby': noticeId } : {})}
          />
          <p
            role="status"
            className={`flex items-start gap-1.5 text-small ${examplesWeak ? 'text-warning-soft-foreground' : 'text-muted'}`}
          >
            {examplesWeak && <Icon name="warning" className="mt-0.75 size-3.5" />}
            {lineCount}
          </p>
        </TextField>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-label">{t('routing.form.signals')}</legend>
          <p className="text-small text-muted">{t('routing.form.signalsHelp')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {ROUTING_SIGNALS.map((signal) => {
              const other = owner(signal);
              return (
                <CheckboxOption
                  key={signal}
                  isSelected={signals.includes(signal)}
                  isDisabled={other !== undefined}
                  onChange={(on) =>
                    setSignals((list) =>
                      on ? [...list, signal] : list.filter((s) => s !== signal),
                    )
                  }
                  label={t(`routing.signal.${signal}`)}
                  {...(other === undefined
                    ? {}
                    : { description: t('routing.form.usedBy', { route: routeLabel(other.name) }) })}
                />
              );
            })}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-label">{t('routing.form.sure')}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <UnitField
              label={t('routing.form.thresholdDown')}
              value={down}
              onChange={setDown}
              description={`${t('routing.form.thresholdDownHelp')}${downNow ? ` ${t('routing.form.appliesNow')}` : ''}`}
              className="[&_[data-slot=input-group]]:w-28"
            />
            <UnitField
              label={t('routing.form.thresholdUp')}
              value={up}
              onChange={setUp}
              description={`${t('routing.form.thresholdUpHelp')}${downNow ? '' : ` ${t('routing.form.appliesNow')}`}`}
              className="[&_[data-slot=input-group]]:w-28"
            />
          </div>
        </fieldset>

        <CheckboxOption
          isSelected={enabled}
          onChange={setEnabled}
          label={t('routing.form.enabled')}
          description={t('routing.form.enabledHelp')}
        />
      </FormDialog>
      {route !== null && (
        <ConfirmDialog
          isOpen={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t('routing.delete.title', { name: routeLabel(route.name) })}
          confirmLabel={t('routing.form.delete')}
          isPending={remove.isPending}
          onConfirm={() => remove.mutate()}
        >
          {t('routing.delete.body')}
        </ConfirmDialog>
      )}
    </>
  );
}
