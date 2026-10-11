import {
  Autocomplete,
  Description,
  EmptyState,
  Label,
  ListBox,
  ListLayout,
  SearchField,
  useFilter,
  Virtualizer,
} from '@heroui/react';
import type { ModelView } from '@lakka/contracts';
import { t } from '../i18n/index.ts';
import { ModelOptionText } from './model-option.tsx';

/*
 * Picks one of the models a workspace can use (priced, with a credential), by its reference, and
 * names each as people see it (CH-2). With `allowNone`, the first option is "None" and stands
 * for null. With `setting`, it is a row of a settings section (Pattern 12). The catalogue runs to
 * hundreds of models, so the list opens with a search field that matches a name or an id, as
 * Find a model on the models page does, and only the rows in view are rendered: building every
 * row stalled the list's opening by over 100ms at catalogue size. Each option shows its id under
 * its name; the field shows the name alone. As a settings row it is wider than other settings
 * controls, so names and ids are not cut short so soon.
 */

const NONE = '__none__';

export function ModelSelect({
  label,
  description,
  models,
  value,
  onChange,
  allowNone = false,
  isRequired = false,
  exclude = [],
  setting = false,
  className = '',
}: {
  label: string;
  description?: string;
  models: readonly ModelView[];
  value: string | null;
  onChange: (model: string | null) => void;
  allowNone?: boolean;
  isRequired?: boolean;
  /** Models not to offer, such as ones already chosen elsewhere in the form. */
  exclude?: readonly string[];
  setting?: boolean;
  className?: string;
}) {
  const offered = models.filter((m) => !exclude.includes(m.id));
  const { contains } = useFilter({ sensitivity: 'base' });
  // An option's key is its model's id, so a search finds it by either.
  const matches = (text: string, query: string, node: { key: unknown }) =>
    contains(text, query) || (node.key !== NONE && contains(String(node.key), query));
  const options = [
    ...(allowNone ? [{ id: NONE, name: t('routing.none'), model: false }] : []),
    ...offered.map((m) => ({ id: m.id, name: m.displayName, model: true })),
  ];
  return (
    <Autocomplete
      selectionMode="single"
      value={value ?? (allowNone ? NONE : null)}
      onChange={(key) => onChange(key === null || key === NONE ? null : String(key))}
      isRequired={isRequired}
      placeholder={allowNone ? t('routing.none') : t('routing.chooseModel')}
      className={`${setting ? 'lk-setting lk-setting-wide' : 'flex flex-col gap-1'} ${className}`}
    >
      <Label>{label}</Label>
      <Autocomplete.Trigger>
        {/* The name alone: the option's own content has its id under it. */}
        <Autocomplete.Value>
          {({ defaultChildren, isPlaceholder, selectedText }) =>
            isPlaceholder ? defaultChildren : selectedText
          }
        </Autocomplete.Value>
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      {description !== undefined && <Description>{description}</Description>}
      <Autocomplete.Popover>
        <Autocomplete.Filter filter={matches}>
          <SearchField autoFocus aria-label={t('modelSelect.find')}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              {/* Its default 20 characters are wider than a narrow list, which pushed the clear
                  button out of sight. */}
              <SearchField.Input
                placeholder={t('modelSelect.findPlaceholder')}
                className="min-w-0 flex-1"
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          {/* A model's row has two lines, its name and its id; None has one. Rows are measured as
              they render. The gap is the 4px HeroUI puts between list items, which placed rows do
              not get. */}
          <Virtualizer layout={ListLayout} layoutOptions={{ estimatedRowSize: 48, gap: 4 }}>
            <ListBox
              items={options}
              renderEmptyState={() => <EmptyState>{t('modelSelect.noMatch')}</EmptyState>}
            >
              {(option) => (
                <ListBox.Item id={option.id} textValue={option.name}>
                  {option.model ? (
                    <ModelOptionText name={option.name} id={option.id} />
                  ) : (
                    option.name
                  )}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              )}
            </ListBox>
          </Virtualizer>
        </Autocomplete.Filter>
      </Autocomplete.Popover>
    </Autocomplete>
  );
}
