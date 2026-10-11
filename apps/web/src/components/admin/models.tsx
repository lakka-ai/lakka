import { useId, useState } from 'react';
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  SearchField,
  TextField,
} from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseModelRef } from '@lakka/contracts';
import type {
  CatalogueFeedView,
  CustomModelBody,
  ModelView,
  ProviderConfigView,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api, ApiError } from '../../lib/api.ts';
import {
  formatPrice,
  modelStatus,
  pageOf,
  priceFeedChangedWords,
  priceFeedCheckWords,
  priceFeedPricesWords,
  priceFeedSwitch,
  priceField,
  readsWords,
} from '../../lib/admin.ts';
import type { ModelStatus } from '../../lib/admin.ts';
import { parseDollarsPerMtok } from '../../lib/money.ts';
import { catalogueFeedQuery } from '../../lib/queries.ts';
import { Icon } from '../icons.tsx';
import { CardInset, CardSection, EmptyList, Pager } from '../patterns/card-section.tsx';
import { ConfirmDialog } from '../patterns/confirm-dialog.tsx';
import { DataTable, RowActions, TwoLine } from '../patterns/data-table.tsx';
import type { Column } from '../patterns/data-table.tsx';
import { UnitField } from '../patterns/fields.tsx';
import { FormDialog } from '../patterns/form-dialog.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { CheckboxOption } from '../patterns/settings.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';
import type { Tone } from '../patterns/status-chip.tsx';
import { ToolSwitch } from '../tools/tool-switch.tsx';

/*
 * Models (PR-5, PR-7; Admin-Models and Admin-Dialogs boards): the catalogue, with whether each
 * model works on the instance's key, and the models an admin added. The catalogue is long, so it
 * has a search and pages of 20. Add a model opens a dialog with focus on Model name; prices have
 * a $ prefix with the currency in the label, sizes a tokens suffix. The form is checked on
 * submit, and focus moves to the first field with a problem. Tool calls is a checkbox the board
 * does not draw: without it a model added by hand could never call a tool (ADR 0097). A model's
 * name cannot change once added, since routes point to it.
 *
 * Price updates (PR-6, ADR 0116), which no board draws, is a card of its own under the models:
 * a switch, since turning it on or off applies at once (Pattern 12), with the host it contacts
 * and that the host sees the server address, what the last check found, and Check now. A
 * catalogue row whose price came from an update says so with a chip.
 */

const MODELS_PER_PAGE = 20;

const STATUS: Readonly<Record<ModelStatus, { word: MessageKey; tone: Tone }>> = {
  available: { word: 'admin.models.available', tone: 'success' },
  refused: { word: 'admin.models.refused', tone: 'danger' },
  failed: { word: 'admin.models.failed', tone: 'danger' },
  unchecked: { word: 'admin.models.unchecked', tone: 'neutral' },
  noKey: { word: 'admin.models.noKey', tone: 'neutral' },
};

const count = (n: number) => n.toLocaleString('en');

function sizeAndPriceColumns(): Column<ModelView>[] {
  return [
    {
      key: 'model',
      header: t('admin.models.col.model'),
      cell: (m) => (
        <TwoLine
          first={
            m.priceUpdated ? (
              <span className="flex items-center gap-2">
                {m.displayName}
                <StatusChip tone="accent">{t('admin.models.priceUpdated')}</StatusChip>
                <span className="sr-only">{t('admin.models.priceUpdatedHelp')}</span>
              </span>
            ) : (
              m.displayName
            )
          }
          second={<span className="font-mono">{m.id}</span>}
        />
      ),
    },
    {
      key: 'context',
      header: t('admin.models.col.context'),
      numeric: true,
      cell: (m) => count(m.contextWindow),
    },
    {
      key: 'output',
      header: t('admin.models.col.outputLimit'),
      numeric: true,
      cell: (m) => count(m.maxOutputTokens),
    },
    {
      key: 'input',
      header: t('admin.models.col.input'),
      numeric: true,
      cell: (m) =>
        m.tiers.length === 0 ? (
          formatPrice(m.prices.inputMicroUsdPerMtok)
        ) : (
          <span className="flex flex-col items-end leading-tight">
            <span>{formatPrice(m.prices.inputMicroUsdPerMtok)}</span>
            {m.tiers.map((tier) => (
              <span
                key={tier.aboveInputTokens}
                className="text-caption whitespace-nowrap text-muted"
              >
                {t('admin.models.longContext', {
                  price: formatPrice(tier.prices.inputMicroUsdPerMtok),
                  tokens: count(tier.aboveInputTokens),
                })}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'outputPrice',
      header: t('admin.models.col.outputPrice'),
      numeric: true,
      cell: (m) => formatPrice(m.prices.outputMicroUsdPerMtok),
    },
    {
      key: 'reads',
      header: t('admin.models.col.reads'),
      cell: (m) => readsWords(m.capabilities),
    },
  ];
}

export function Catalogue({
  models,
  providers,
}: {
  models: readonly ModelView[];
  providers: readonly ProviderConfigView[];
}) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const q = query.trim().toLowerCase();
  const found = models.filter(
    (m) => q === '' || m.id.includes(q) || m.displayName.toLowerCase().includes(q),
  );
  const shown = pageOf(found, page, MODELS_PER_PAGE);
  return (
    <div className="flex flex-col gap-3">
      <CardSection
        title={t('admin.models.catalogue')}
        subtitle={t('admin.models.catalogueHelp')}
        titleId={titleId}
        flush
      >
        <div className="flex flex-col gap-1 px-5">
          <SearchField
            value={query}
            onChange={(value) => {
              setQuery(value);
              setPage(0);
            }}
            className="w-full max-w-sm"
          >
            <Label>{t('admin.models.find')}</Label>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t('admin.models.findPlaceholder')} />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          {/* Read out as people type; the table shows the result. */}
          <p role="status" className="sr-only">
            {q === ''
              ? ''
              : found.length === 1
                ? t('admin.models.matchOne')
                : t('admin.models.matches', { n: String(found.length) })}
          </p>
        </div>
        {shown.rows.length === 0 ? (
          <EmptyList>{t('admin.models.noMatch')}</EmptyList>
        ) : (
          <DataTable
            labelledBy={titleId}
            name={t('admin.models.catalogue')}
            columns={[
              ...sizeAndPriceColumns(),
              {
                key: 'status',
                header: t('admin.models.col.status'),
                cell: (m) => {
                  const s = STATUS[modelStatus(m, providers)];
                  return <StatusChip tone={s.tone}>{t(s.word)}</StatusChip>;
                },
              },
            ]}
            rows={shown.rows}
            rowKey={(m) => m.id}
          />
        )}
      </CardSection>
      <Pager
        from={shown.from}
        to={shown.to}
        total={shown.total}
        hasPrevious={shown.hasPrevious}
        hasNext={shown.hasNext}
        onPrevious={() => setPage(shown.page - 1)}
        onNext={() => setPage(shown.page + 1)}
      />
    </div>
  );
}

export function CustomModels({ models }: { models: readonly ModelView[] }) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ModelView | 'new' | null>(null);
  const [removing, setRemoving] = useState<ModelView | null>(null);
  const [status, setStatus] = useState('');
  const remove = useMutation({
    mutationFn: (m: ModelView) =>
      api(`/api/models/custom/${m.customModelId ?? ''}`, {
        method: 'DELETE',
      }),
    onSuccess: async (_r, m) => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ['models'] });
      setStatus(t('admin.models.removed', { name: m.displayName }));
    },
  });
  return (
    <CardSection
      title={t('admin.models.custom')}
      subtitle={t('admin.models.customHelp')}
      titleId={titleId}
      flush={models.length > 0}
      actions={
        <Button size="lg" variant="primary" onPress={() => setEditing('new')}>
          <Icon name="plus" />
          {t('admin.models.add')}
        </Button>
      }
    >
      <p role="status" className="sr-only">
        {status}
      </p>
      {remove.isError && (
        <CardInset>
          <ErrorNotice title={t('app.error')} />
        </CardInset>
      )}
      {models.length === 0 ? (
        <EmptyList>{t('admin.models.none')}</EmptyList>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('admin.models.custom')}
          columns={[
            ...sizeAndPriceColumns(),
            {
              key: 'actions',
              header: t('admin.models.col.actions'),
              cell: (m) => (
                <RowActions
                  name={m.displayName}
                  actions={[
                    {
                      id: 'edit',
                      label: t('admin.models.edit'),
                      name: t('admin.models.editFor', { name: m.displayName }),
                      onAction: () => setEditing(m),
                    },
                    {
                      id: 'remove',
                      label: t('admin.models.remove'),
                      name: t('admin.models.removeFor', { name: m.displayName }),
                      danger: true,
                      onAction: () => setRemoving(m),
                    },
                  ]}
                />
              ),
            },
          ]}
          rows={models}
          rowKey={(m) => m.id}
        />
      )}
      {editing !== null && (
        <ModelDialog
          model={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={setStatus}
        />
      )}
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('admin.models.removeTitle', { name: removing?.displayName ?? '' })}
        confirmLabel={t('admin.models.remove')}
        isPending={remove.isPending}
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing);
        }}
      >
        {t('admin.models.removeBody')}
      </ConfirmDialog>
    </CardSection>
  );
}

type Field = 'ref' | 'contextWindow' | 'maxOutput' | 'input' | 'output';

const FIELD_ERROR: Readonly<Record<Field, MessageKey>> = {
  ref: 'admin.models.refInvalid',
  contextWindow: 'admin.models.tokensInvalid',
  maxOutput: 'admin.models.tokensInvalid',
  input: 'admin.models.priceInvalid',
  output: 'admin.models.priceInvalid',
};

const wholeTokens = (text: string) => {
  const n = Number(text.trim().replaceAll(',', ''));
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

function ModelDialog({
  model,
  onClose,
  onDone,
}: {
  /** Null to add one. */
  model: ModelView | null;
  onClose: () => void;
  onDone: (status: string) => void;
}) {
  const queryClient = useQueryClient();
  const [problems, setProblems] = useState<Field[]>([]);
  const [failed, setFailed] = useState<MessageKey | null>(null);
  const [vision, setVision] = useState(model?.capabilities.vision ?? false);
  const [pdf, setPdf] = useState(model?.capabilities.pdf ?? false);
  const [tools, setTools] = useState(model?.capabilities.tools ?? true);
  const save = useMutation({
    mutationFn: (body: CustomModelBody) =>
      model === null
        ? api('/api/models/custom', { method: 'POST', body })
        : api(`/api/models/custom/${model.customModelId ?? ''}`, { method: 'PUT', body }),
    onSuccess: async (_r, body) => {
      await queryClient.invalidateQueries({ queryKey: ['models'] });
      onDone(
        t(model === null ? 'admin.models.added' : 'admin.models.saved', {
          name: body.displayName ?? `${body.provider}:${body.model}`,
        }),
      );
      onClose();
    },
    onError: (e) =>
      setFailed(
        e instanceof ApiError && e.code === 'model_exists' ? 'admin.models.exists' : 'app.error',
      ),
  });

  function submit(form: FormData) {
    setFailed(null);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const ref = model === null ? parseModelRef(text('ref')) : model;
    const contextWindow = wholeTokens(text('contextWindow'));
    const maxOutputTokens = wholeTokens(text('maxOutput'));
    const input = parseDollarsPerMtok(text('input'));
    const output = parseDollarsPerMtok(text('output'));
    const wrong: Field[] = [
      ...(ref === undefined ? (['ref'] as const) : []),
      ...(contextWindow === undefined ? (['contextWindow'] as const) : []),
      ...(maxOutputTokens === undefined ? (['maxOutput'] as const) : []),
      ...(input === undefined ? (['input'] as const) : []),
      ...(output === undefined ? (['output'] as const) : []),
    ];
    setProblems(wrong);
    if (wrong.length > 0) {
      // Focus goes to the first field with a problem (accessibility.md, Models).
      // After the press that submitted, which keeps focus on the button until it ends.
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLInputElement>(`[role=dialog] [name="${wrong[0] ?? ''}"]`)
          ?.focus(),
      );
      return;
    }
    if (
      ref === undefined ||
      contextWindow === undefined ||
      maxOutputTokens === undefined ||
      input === undefined ||
      output === undefined
    ) {
      return;
    }
    const displayName = text('displayName');
    save.mutate({
      provider: ref.provider,
      model: ref.model,
      ...(displayName === '' ? {} : { displayName }),
      contextWindow,
      maxOutputTokens,
      capabilities: {
        vision,
        pdf,
        tools,
        structuredOutput: model?.capabilities.structuredOutput ?? false,
        promptCaching: model?.capabilities.promptCaching ?? false,
        reasoning: model?.capabilities.reasoning ?? false,
      },
      prices: {
        inputMicroUsdPerMtok: input,
        outputMicroUsdPerMtok: output,
        cacheReadMicroUsdPerMtok: model?.prices.cacheReadMicroUsdPerMtok ?? null,
        cacheWriteMicroUsdPerMtok: model?.prices.cacheWriteMicroUsdPerMtok ?? null,
      },
    });
  }

  const error = (field: Field) =>
    problems.includes(field)
      ? { isInvalid: true, description: t(FIELD_ERROR[field]) }
      : { isInvalid: false };

  return (
    <FormDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        model === null
          ? t('admin.models.addTitle')
          : t('admin.models.editTitle', { name: model.displayName })
      }
      submitLabel={model === null ? t('admin.models.addSubmit') : t('admin.models.save')}
      isSubmitting={save.isPending}
      {...(failed === null ? {} : { error: { title: t(failed) } })}
      onSubmit={submit}
    >
      {/* The id and the name share the first row, as drawn. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="ref"
          isRequired
          validationBehavior="aria"
          isInvalid={model === null && problems.includes('ref')}
          {...(model === null ? {} : { isReadOnly: true, defaultValue: model.id })}
        >
          <Label>{t('admin.models.ref')}</Label>
          <Input
            spellCheck={false}
            autoCapitalize="none"
            placeholder={t('admin.models.refPlaceholder')}
            className="font-mono"
          />
          {model === null && problems.includes('ref') ? (
            <FieldError>{t('admin.models.refInvalid')}</FieldError>
          ) : (
            <Description>
              {model === null ? t('admin.models.refHelp') : t('admin.models.refFixed')}
            </Description>
          )}
        </TextField>
        <TextField name="displayName" defaultValue={model?.displayName ?? ''} maxLength={80}>
          <Label>{t('admin.models.displayName')}</Label>
          <Input placeholder={t('admin.models.displayNamePlaceholder')} />
          <Description>{t('admin.models.displayNameHelp')}</Description>
        </TextField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <UnitField
          name="contextWindow"
          label={t('admin.models.contextWindow')}
          suffix={t('admin.models.tokens')}
          inputMode="numeric"
          alignEnd
          defaultValue={model === null ? '' : String(model.contextWindow)}
          {...error('contextWindow')}
          isRequired
          validationBehavior="aria"
        />
        <UnitField
          name="maxOutput"
          label={t('admin.models.outputLimit')}
          suffix={t('admin.models.tokens')}
          inputMode="numeric"
          alignEnd
          defaultValue={model === null ? '' : String(model.maxOutputTokens)}
          {...error('maxOutput')}
          isRequired
          validationBehavior="aria"
        />
        <UnitField
          name="input"
          label={t('admin.models.inputPrice')}
          srLabel={t('admin.models.inDollars')}
          prefix="$"
          defaultValue={model === null ? '' : priceField(model.prices.inputMicroUsdPerMtok)}
          {...error('input')}
          isRequired
          validationBehavior="aria"
        />
        <UnitField
          name="output"
          label={t('admin.models.outputPrice')}
          srLabel={t('admin.models.inDollars')}
          prefix="$"
          defaultValue={model === null ? '' : priceField(model.prices.outputMicroUsdPerMtok)}
          {...error('output')}
          isRequired
          validationBehavior="aria"
        />
      </div>
      <p className="text-small text-muted">{t('admin.models.pricesHelp')}</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-label">{t('admin.models.canRead')}</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <CheckboxOption
            isSelected={vision}
            onChange={setVision}
            label={t('admin.models.images')}
          />
          <CheckboxOption isSelected={pdf} onChange={setPdf} label={t('admin.models.pdfFiles')} />
        </div>
      </fieldset>
      <CheckboxOption
        isSelected={tools}
        onChange={setTools}
        label={t('admin.models.tools')}
        description={t('admin.models.toolsHelp')}
      />
    </FormDialog>
  );
}

const FEED_REFUSALS: Readonly<Record<string, MessageKey>> = {
  catalogue_feed_no_key: 'admin.models.feed.noKey',
  catalogue_feed_locked: 'admin.models.feed.locked',
};

export function PriceUpdates({ feed }: { feed: CatalogueFeedView }) {
  const queryClient = useQueryClient();
  const helpId = useId();
  const [status, setStatus] = useState('');
  const failed = (e: Error) =>
    setStatus(t(e instanceof ApiError ? (FEED_REFUSALS[e.code] ?? 'app.error') : 'app.error'));
  const done = async (after: CatalogueFeedView, said: MessageKey) => {
    queryClient.setQueryData(catalogueFeedQuery.queryKey, after);
    // Prices change with the switch, so the catalogue is read again.
    await queryClient.invalidateQueries({ queryKey: ['models'], exact: true });
    setStatus(t(said));
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ feed: CatalogueFeedView }>('/api/models/catalogue-feed', {
        method: 'PUT',
        body: { enabled },
      }),
    onSuccess: ({ feed: after }) =>
      done(after, after.enabled ? 'admin.models.feed.nowOn' : 'admin.models.feed.nowOff'),
    onError: failed,
  });
  const check = useMutation({
    mutationFn: () =>
      api<{ feed: CatalogueFeedView }>('/api/models/catalogue-feed/check', {
        method: 'POST',
        body: {},
      }),
    onSuccess: ({ feed: after }) => done(after, 'admin.models.feed.checkRequested'),
    onError: failed,
  });
  const control = priceFeedSwitch(feed);
  const changed = priceFeedChangedWords(feed);
  return (
    <CardSection
      title={t('admin.models.feed.title')}
      subtitle={t('admin.models.feed.subtitle')}
      badge={
        <StatusChip tone={feed.enabled ? 'success' : 'neutral'}>
          {feed.enabled ? t('admin.models.feed.on') : t('admin.models.feed.off')}
        </StatusChip>
      }
      {...(feed.enabled && feed.unavailable === null
        ? {
            actions: (
              <Button
                size="lg"
                variant="tertiary"
                isPending={check.isPending}
                onPress={() => {
                  setStatus('');
                  check.mutate();
                }}
              >
                <Icon name="retry" />
                {t('admin.models.feed.checkNow')}
              </Button>
            ),
          }
        : {})}
    >
      {control.shown ? (
        <div className="lk-setting-row flex items-start justify-between gap-6 border-t border-separator">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold">{t('admin.models.feed.switch')}</span>
            <span id={helpId} className="text-small text-muted">
              {t('admin.models.feed.switchHelp', { host: feed.host ?? '' })}
            </span>
            {control.blockedReason !== undefined && (
              <span className="text-small">{control.blockedReason}</span>
            )}
          </div>
          <ToolSwitch
            label={t('admin.models.feed.switch')}
            isSelected={feed.enabled}
            describedBy={helpId}
            {...(control.blockedReason === undefined
              ? {}
              : { disabledReason: control.blockedReason })}
            onChange={(on) => {
              setStatus('');
              toggle.mutate(on);
            }}
          />
        </div>
      ) : (
        <p>{t('admin.models.feed.locked')}</p>
      )}
      <div className="lk-num flex flex-col gap-1">
        <p>{priceFeedPricesWords(feed)}</p>
        <p className="text-small text-muted">
          {feed.checkRequested ? t('admin.models.feed.checkRequested') : priceFeedCheckWords(feed)}
        </p>
        {changed !== undefined && <p className="text-small text-muted">{changed}</p>}
      </div>
      <p role="status" className="sr-only">
        {status}
      </p>
    </CardSection>
  );
}
