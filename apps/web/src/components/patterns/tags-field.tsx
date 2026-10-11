import { useState } from 'react';
import {
  Autocomplete,
  Description,
  EmptyState,
  Label,
  ListBox,
  SearchField,
  Tag,
  TagGroup,
  TagRemoveButton,
  useFilter,
} from '@heroui/react';

/*
 * A field of values, each a tag with a remove button (ADR 0109): the alert percentages, the
 * allowed email domains. It is a multiple-selection Autocomplete. Its list may suggest values,
 * and any value typed into its search field that `parse` accepts is offered too, so a value is
 * picked from the list or typed, the same way. Typed text that is not one empties the list and
 * says why. Picked values stay offered while picked, so each shows and can be removed. With
 * `max`, once that many are picked the other options are disabled until one is removed.
 *
 * Values are strings; `parse` turns typed text into one ("75 %" into "75", "Example.com" into
 * "example.com"), and `format` is how a value reads.
 */
export function TagsField({
  label,
  description,
  placeholder,
  findLabel,
  findPlaceholder,
  suggestions = [],
  value,
  onChange,
  parse,
  format = (v) => v,
  removeLabel,
  hint,
  invalid,
  max,
  sort,
  numeric = false,
}: {
  label: string;
  description: string;
  /** What the field says with nothing picked. */
  placeholder: string;
  findLabel: string;
  findPlaceholder: string;
  /** Values offered before anything is typed. */
  suggestions?: readonly string[];
  value: readonly string[];
  onChange: (values: string[]) => void;
  /** The value typed text stands for, or undefined if it is not one. */
  parse: (text: string) => string | undefined;
  format?: (value: string) => string;
  removeLabel: (value: string) => string;
  /** Said in the list when nothing is typed and nothing is offered. */
  hint: string;
  /** Said in the list when the typed text is not a value. */
  invalid: string;
  max?: number;
  /** The order values are kept and listed in; as picked when not given. */
  sort?: (a: string, b: string) => number;
  /** Digits: a numeric keyboard, and figures that line up. */
  numeric?: boolean;
}) {
  const [query, setQuery] = useState('');
  const typed = parse(query);
  const offered = [...new Set([...suggestions, ...value, ...(typed === undefined ? [] : [typed])])];
  const options = sort === undefined ? offered : offered.toSorted(sort);
  const full = max !== undefined && value.length >= max;
  const { contains } = useFilter({ sensitivity: 'base' });
  // The typed value always matches, however it was written ("75 %", "Example.com").
  const matches = (text: string, search: string, node: { key: unknown }) =>
    contains(text, search.trim()) || (typed !== undefined && node.key === typed);
  const ordered = (keys: readonly string[]) =>
    sort === undefined ? [...keys] : keys.toSorted(sort);
  const num = numeric ? 'lk-num' : '';
  return (
    <Autocomplete
      selectionMode="multiple"
      value={[...value]}
      onChange={(keys) => {
        const next = (Array.isArray(keys) ? keys : []).map(String); // A typed value, once picked, clears the search for the next one.
        if (typed !== undefined && next.includes(typed) && !value.includes(typed)) setQuery('');
        onChange(ordered(next));
      }}
      // The select owns the collection, so the cap on picks sits here rather than on the list.
      disabledKeys={full ? options.filter((v) => !value.includes(v)) : []}
      // With nothing suggested or picked the list is empty, and still opens: it is where to type.
      allowsEmptyCollection
      // A search left behind would hide options the next time the list opens.
      onOpenChange={(open) => {
        if (!open) setQuery('');
      }}
      placeholder={placeholder}
    >
      <Label>{label}</Label>
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {({ defaultChildren, isPlaceholder }) =>
            isPlaceholder || value.length === 0 ? (
              defaultChildren
            ) : (
              // The sm tag fits inside the field, so the field keeps its height.
              <TagGroup
                size="sm"
                aria-label={label}
                onRemove={(keys) => onChange(value.filter((v) => !keys.has(v)))}
              >
                <TagGroup.List className="flex flex-wrap gap-1.5">
                  {value.map((v) => (
                    <Tag key={v} id={v} textValue={format(v)} className={num}>
                      {format(v)}
                      <TagRemoveButton aria-label={removeLabel(v)} />
                    </Tag>
                  ))}
                </TagGroup.List>
              </TagGroup>
            )
          }
        </Autocomplete.Value>
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <Description>{description}</Description>
      <Autocomplete.Popover>
        <Autocomplete.Filter filter={matches} inputValue={query} onInputChange={setQuery}>
          <SearchField autoFocus aria-label={findLabel}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input
                placeholder={findPlaceholder}
                spellCheck={false}
                autoCapitalize="none"
                {...(numeric ? { inputMode: 'numeric' as const } : {})}
                className="min-w-0 flex-1"
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          {/* A typed value is always an option, so an empty list means nothing was typed and
              nothing is suggested, or the text is not a value. */}
          <ListBox
            renderEmptyState={() => <EmptyState>{query.trim() === '' ? hint : invalid}</EmptyState>}
          >
            {options.map((v) => (
              <ListBox.Item key={v} id={v} textValue={format(v)} className={num}>
                {format(v)}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Autocomplete.Filter>
      </Autocomplete.Popover>
    </Autocomplete>
  );
}
