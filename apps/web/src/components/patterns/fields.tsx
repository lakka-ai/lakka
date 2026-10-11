import { useId } from 'react';
import type { ComponentProps } from 'react';
import { Description, FieldError, Input, InputGroup, Label, TextField } from '@heroui/react';
import { t } from '../../i18n/index.ts';
import { StatusChip } from './status-chip.tsx';

/*
 * Patterns 6 and 11: the write-only credential field and the field with a unit.
 */

type TextFieldProps = Omit<ComponentProps<typeof TextField>, 'children' | 'className'>;

/**
 * Pattern 6 (PR-3). A stored secret never comes back to the browser, so the field is always
 * empty; a "Key set" chip and the description say a value exists. Save and Remove belong to
 * the dialog or form around it. With isInvalid, `error` takes the description's place, tied to the
 * input as every field's error is (patterns.md, States).
 */
export function WriteOnlyField({
  label,
  isSet,
  setDetail,
  emptyPlaceholder = t('credential.placeholder.none'),
  emptyHelp = t('credential.none'),
  error,
  className = '',
  ...field
}: TextFieldProps & {
  label: string;
  isSet: boolean;
  /** When and by whom, if known: "Set on Sep 12 by Maja Lind." */
  setDetail?: string;
  /** What to paste, when nothing is set yet, if not a key: "Paste the token or password". */
  emptyPlaceholder?: string;
  /** The help under the field when nothing is set yet. */
  emptyHelp?: string;
  /** How to fix it, shown while the field is invalid. */
  error?: string;
  className?: string;
}) {
  const description = isSet
    ? [t('credential.set'), setDetail].filter(Boolean).join(' ')
    : emptyHelp;
  return (
    <TextField type="password" autoComplete="off" className={className} {...field}>
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        {isSet && (
          <StatusChip tone="success" icon="lock">
            {t('credential.keySet')}
          </StatusChip>
        )}
      </div>
      <Input
        placeholder={isSet ? t('credential.placeholder.set') : emptyPlaceholder}
        spellCheck={false}
      />
      <Description>{description}</Description>
      {error !== undefined && <FieldError>{error}</FieldError>}
    </TextField>
  );
}

/**
 * Pattern 11. The unit is plain muted text inside the field, so the group reads as one input
 * and the focus ring goes round all of it.
 *
 * - A currency prefix is aria-hidden; the currency goes in the label, visually hidden, as
 *   `srLabel` (", in US dollars").
 * - A suffix such as days or tokens is read after the value, through aria-describedby. A
 *   suffix the label already says, such as %, is hidden with `hideSuffix`.
 * - Short numbers sit right aligned against their suffix with `alignEnd`.
 */
export function UnitField({
  label,
  srLabel,
  prefix,
  suffix,
  hideSuffix = false,
  alignEnd = false,
  description,
  placeholder,
  inputMode = 'decimal',
  setting = false,
  className = '',
  ...field
}: TextFieldProps & {
  label: string;
  srLabel?: string;
  prefix?: string;
  suffix?: string;
  hideSuffix?: boolean;
  alignEnd?: boolean;
  description?: string;
  placeholder?: string;
  inputMode?: 'decimal' | 'numeric';
  /** A row in a settings section (Pattern 12), laid out by the row. */
  setting?: boolean;
  className?: string;
}) {
  const suffixId = useId();
  const descriptionId = useId();
  const describedBy =
    [
      suffix !== undefined && !hideSuffix ? suffixId : null,
      description === undefined ? null : descriptionId,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <TextField className={`${setting ? 'lk-setting' : ''} ${className}`} {...field}>
      <Label>
        {label}
        {srLabel !== undefined && <span className="sr-only">{srLabel}</span>}
      </Label>
      <InputGroup>
        {prefix !== undefined && (
          <InputGroup.Prefix
            aria-hidden="true"
            className="border-0 bg-transparent ps-3 pe-1.5 text-muted"
          >
            {prefix}
          </InputGroup.Prefix>
        )}
        <InputGroup.Input
          inputMode={inputMode}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          className={`lk-num w-full min-w-0 placeholder:normal-nums ${alignEnd ? 'text-right' : ''} ${prefix === undefined ? '' : 'ps-0'}`}
        />
        {suffix !== undefined && (
          <InputGroup.Suffix
            id={suffixId}
            aria-hidden={hideSuffix ? 'true' : undefined}
            className="border-0 bg-transparent ps-1.5 pe-3 text-muted"
          >
            {suffix}
          </InputGroup.Suffix>
        )}
      </InputGroup>
      {description !== undefined && <Description id={descriptionId}>{description}</Description>}
    </TextField>
  );
}
