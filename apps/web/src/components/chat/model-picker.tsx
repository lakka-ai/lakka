import { useId, useState } from 'react';
import type { Key } from 'react';
import {
  Autocomplete,
  Description,
  Header,
  Label,
  ListBox,
  SearchField,
  Select,
  useFilter,
} from '@heroui/react';
import type { RequestableView } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';
import { ModelOptionText } from '../model-option.tsx';
import { readsText, routeLabel } from './copy.ts';

/*
 * The model picker (CH-3; Chat-States board, "Model picker open"): Auto, the routes with the
 * model each sends to, then the models with what each reads. Choosing one keeps it for the
 * conversation instead of Auto, and is recorded as the person's choice. With routing off there
 * is no Auto: the workspace default answers unless another model is chosen. A pinned model
 * answers unless the person picks another one, since their own choice comes first (RT-3, ADR
 * 0094): the picker shows the pinned model, offers no Auto, and records any other pick.
 *
 * A workspace can offer hundreds of models, so the list opens with a search field, which the
 * board does not draw (asked for by the project owner): it matches a route by its name or the
 * model it sends to, and a model by its name or id. Auto stays at the top whatever is typed, so
 * going back to it is always one step away. Each model shows its id under its name, and what it
 * reads as icons, with the words for screen readers and on hover. Unlike the model select, every
 * row is rendered, as before: React Aria's virtualized lists
 * count a section's heading as an option's position, so screen readers heard "2 of 8" for the
 * first model of each section.
 */

export const AUTO = 'auto';

/** The picker's value: the stored choice, or what answers without one. */
function valueOf(requestable: RequestableView, choice: string | null): string {
  if (choice !== null) return choice;
  if (requestable.routing.pinnedModel !== null) return requestable.routing.pinnedModel.id;
  if (!requestable.routing.enabled && requestable.routing.defaultModel !== null) {
    return requestable.routing.defaultModel.id;
  }
  return AUTO;
}

/**
 * What a pick records as the person's choice: nothing for Auto or for the pinned model, which
 * answer without one, and the route or model otherwise (CH-3, RT-3).
 */
export function choiceFor(
  requestable: Pick<RequestableView, 'routing'>,
  key: Key | null,
): string | null {
  if (key === null || key === AUTO) return null;
  if (requestable.routing.pinnedModel?.id === key) return null;
  return String(key);
}

/** The chosen thing's name, for the trigger. */
export function choiceName(requestable: RequestableView, choice: string | null): string {
  const value = valueOf(requestable, choice);
  if (value === AUTO) return t('chat.model.auto');
  if (value.startsWith('route/')) return routeLabel(value.slice('route/'.length));
  return (
    requestable.models.find((m) => m.id === value)?.displayName ??
    (requestable.routing.defaultModel?.id === value ? requestable.routing.defaultModel.name : value)
  );
}

type Named = Pick<RequestableView['models'][number], 'id' | 'displayName'>;

/** What a search finds each option by besides its name: a route's model, a model's id. */
export function alsoFoundBy(
  routes: readonly { id: string; model: string; modelName: string }[],
  models: readonly Named[],
): Map<Key, string> {
  return new Map<Key, string>([
    ...routes.map((r): [string, string] => [r.id, `${r.modelName} ${r.model}`]),
    ...models.map((m): [string, string] => [m.id, m.id]),
  ]);
}

/** What a model reads, as small icons: images, PDFs, or text only. The words are its name. */
function Reads({ input }: { input: RequestableView['models'][number]['input'] }) {
  const words = readsText(input);
  return (
    <span title={words} className="flex shrink-0 items-center gap-1 text-muted">
      <span className="sr-only">{words}</span>
      {input.images && <Icon name="image" className="size-3.5" />}
      {input.pdf && <Icon name="file" className="size-3.5" />}
      {!input.images && !input.pdf && <Icon name="text" className="size-3.5" />}
    </span>
  );
}

export function ModelPicker({
  requestable,
  choice,
  onChange,
  isDisabled = false,
  variant,
  id,
}: {
  requestable: RequestableView;
  choice: string | null;
  onChange: (value: string | null) => void;
  isDisabled?: boolean;
  variant: 'header' | 'bar';
  /** For "Pick another model", which moves focus here. */
  id: string;
}) {
  const pinnedNote = useId();
  const value = valueOf(requestable, choice);
  const pinned = requestable.routing.pinnedModel;
  const routes = requestable.routes.map((r) => ({ ...r, id: `route/${r.name}` }));
  const models = [...requestable.models];
  // A choice made earlier that is no longer offered still shows, so the picker never lies.
  if (
    value !== AUTO &&
    !routes.some((r) => r.id === value) &&
    !models.some((m) => m.id === value)
  ) {
    if (value.startsWith('route/')) {
      const name = value.slice('route/'.length);
      routes.unshift({
        id: value,
        name,
        model: '',
        modelName: '',
        input: { images: false, pdf: false },
      });
    } else {
      models.unshift({
        id: value,
        displayName: choiceName(requestable, value),
        input: { images: false, pdf: false },
      });
    }
  }
  const name = choiceName(requestable, choice);

  const extra = alsoFoundBy(routes, models);
  const { contains } = useFilter({ sensitivity: 'base' });
  const [query, setQuery] = useState('');
  const found = (text: string, key: Key) =>
    contains(text, query) || contains(extra.get(key) ?? '', query);
  const anyFound =
    query.trim() === '' ||
    routes.some((r) => found(routeLabel(r.name), r.id)) ||
    models.some((m) => found(m.displayName, m.id));

  return (
    <Select
      value={value}
      onChange={(key) => onChange(choiceFor(requestable, key))}
      onOpenChange={(open) => {
        if (open) setQuery('');
      }}
      isDisabled={isDisabled}
      className="shrink-0"
      {...(pinned === null ? {} : { 'aria-describedby': pinnedNote })}
    >
      <Label className="sr-only">{t('chat.picker.label')}</Label>
      <Select.Trigger
        id={id}
        className={
          variant === 'header'
            ? // As tall as the cap meter beside it; its two lines, Model and the model's name,
              // fit without block padding.
              'lk-chat-control min-w-34 items-center gap-2.5 py-0 text-left'
            : 'items-center gap-2'
        }
      >
        {variant === 'header' ? (
          <span className="flex min-w-0 grow flex-col leading-tight">
            <span aria-hidden="true" className="text-caption text-muted">
              {t('chat.picker.label')}
            </span>
            <span className="truncate text-body font-semibold">{name}</span>
          </span>
        ) : (
          <span className="max-w-28 truncate text-body font-semibold">{name}</span>
        )}
        <Icon name="chevronDown" className="size-3.5 text-muted" />
      </Select.Trigger>
      {pinned !== null && (
        <Description id={pinnedNote} className="sr-only">
          {t('chat.emptyPinned', { model: pinned.name })}
        </Description>
      )}
      {/* Styled as the model select's list (HeroUI's autocomplete popover), so the two pickers
          look alike: the search field and the list are inset, the list scrolls under the field,
          and a focused option's ring is drawn inside it (app.css). It keeps its own width, wider
          than its trigger, where the select's matches its field. */}
      <Select.Popover className="autocomplete__popover lk-popover-fit w-88">
        <Autocomplete.Filter
          filter={(text, _input, node) => node.key === AUTO || found(text, node.key)}
          inputValue={query}
          onInputChange={setQuery}
        >
          <SearchField autoFocus aria-label={t('chat.picker.find')}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input
                placeholder={t('chat.picker.findPlaceholder')}
                className="min-w-0 flex-1"
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <ListBox aria-label={t('chat.picker.label')}>
            {requestable.routing.enabled && pinned === null && (
              <ListBox.Item id={AUTO} textValue={t('chat.model.auto')}>
                <span className="flex flex-col">
                  <span className="font-semibold">{t('chat.model.auto')}</span>
                  <span className="text-caption text-muted">{t('chat.picker.autoHelp')}</span>
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            )}
            {routes.length > 0 && (
              <ListBox.Section>
                <Header>{t('chat.model.routes')}</Header>
                {routes.map((r) => (
                  <ListBox.Item key={r.id} id={r.id} textValue={routeLabel(r.name)}>
                    <span className="grow">{routeLabel(r.name)}</span>
                    <span className="text-caption text-muted">{r.modelName}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox.Section>
            )}
            {models.length > 0 && (
              <ListBox.Section>
                <Header>{t('chat.model.models')}</Header>
                {models.map((m) => (
                  <ListBox.Item key={m.id} id={m.id} textValue={m.displayName}>
                    <ModelOptionText name={m.displayName} id={m.id} />
                    <Reads input={m.input} />
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox.Section>
            )}
          </ListBox>
        </Autocomplete.Filter>
        {/* Auto is never filtered out, so the list is never empty; this says nothing else is. */}
        <p role="status" className="px-3 pb-2 text-caption text-muted empty:hidden">
          {anyFound ? '' : t('chat.picker.noMatch')}
        </p>
        <p className="border-t border-separator px-3 py-2 text-caption text-muted">
          {t('chat.picker.note')}
        </p>
      </Select.Popover>
    </Select>
  );
}
