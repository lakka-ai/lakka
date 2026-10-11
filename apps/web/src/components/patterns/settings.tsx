import type { ReactNode } from 'react';
import { Button, Checkbox, Description, Label, Radio } from '@heroui/react';
import type { ComponentProps } from 'react';
import { t } from '../../i18n/index.ts';
import { CardSection } from './card-section.tsx';

/*
 * Pattern 12, the settings section. One option per row: label and description on the left, the
 * control on the right, a divider between rows, Save under the last divider on the right.
 *
 * - On/off options are checkboxes, because nothing applies until Save. A Switch is only for a
 *   change that applies at once, such as Enabled in a tool list.
 * - Each row's label is tied to its control and its description through aria-describedby;
 *   HeroUI's field components do that when the row is the field itself, so a field row is a
 *   UnitField or Select with the `lk-setting` class, laid out by it.
 * - On a phone, checkboxes stay on the right; selects and fields move under their label at full
 *   width.
 * - When Save finishes, a status line says the settings were saved.
 */

export function SettingsSection({
  title,
  subtitle,
  headingLevel = 2,
  onSave,
  isSaving = false,
  saved = false,
  saveLabel = t('common.save'),
  children,
}: {
  title: string;
  subtitle?: string;
  headingLevel?: 2 | 3;
  /** Absent for a section of read-only rows, as members see it. */
  onSave?: () => void;
  isSaving?: boolean;
  /** True once the last save finished, until something changes again. */
  saved?: boolean;
  saveLabel?: string;
  children: ReactNode;
}) {
  return (
    <CardSection
      title={title}
      headingLevel={headingLevel}
      {...(subtitle === undefined ? {} : { subtitle })}
    >
      <div className="flex flex-col border-t border-separator">{children}</div>
      {onSave !== undefined && (
        <div className="flex items-center justify-end gap-3 pt-3">
          <p role="status" className="text-small text-muted">
            {saved ? t('settings.saved') : ''}
          </p>
          <Button size="lg" variant="primary" isPending={isSaving} onPress={onSave}>
            {saveLabel}
          </Button>
        </div>
      )}
    </CardSection>
  );
}

type CheckboxProps = Omit<ComponentProps<typeof Checkbox>, 'children' | 'className'>;

/**
 * An on/off option, applied by Save. The whole row is the checkbox's label: HeroUI's
 * Checkbox.Content is the clickable part, so it holds the control as well as the text.
 */
export function CheckboxSetting({
  label,
  description,
  ...checkbox
}: CheckboxProps & { label: string; description?: string }) {
  return (
    <Checkbox className="lk-setting-row w-full" {...checkbox}>
      <Checkbox.Content className="flex w-full items-start justify-between gap-6 text-start">
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <Label className="font-semibold">{label}</Label>
          {description !== undefined && <Description>{description}</Description>}
        </span>
        <Checkbox.Control className="mt-0.5 shrink-0">
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  );
}

/**
 * A checkbox with its label beside it, in a form or a dialog: "PDF files", "Use this route".
 * The control, label and description are one clickable label (Checkbox.Content).
 */
export function CheckboxOption({
  label,
  description,
  className = '',
  ...checkbox
}: CheckboxProps & { label: ReactNode; description?: ReactNode; className?: string }) {
  return (
    <Checkbox className={className} {...checkbox}>
      <Checkbox.Content className="flex items-start gap-2.5 text-start">
        <Checkbox.Control className="mt-0.5 shrink-0">
          <Checkbox.Indicator />
        </Checkbox.Control>
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <Label>{label}</Label>
          {description !== undefined && <Description>{description}</Description>}
        </span>
      </Checkbox.Content>
    </Checkbox>
  );
}

type RadioProps = Omit<ComponentProps<typeof Radio>, 'children' | 'className'>;

/**
 * A radio with its label beside it and its description under the label, in a RadioGroup:
 * "Streamable HTTP", "Monthly". `card` draws it as an option card (Tools-Add), a 10px box that
 * takes the accent edge and fill when chosen.
 */
export function RadioOption({
  label,
  description,
  card = false,
  ...radio
}: RadioProps & { label: ReactNode; description?: ReactNode; card?: boolean }) {
  return (
    <Radio className={card ? 'lk-option' : ''} {...radio}>
      <Radio.Content>
        <Radio.Control>
          <Radio.Indicator />
        </Radio.Control>
        <Label>{label}</Label>
      </Radio.Content>
      {description !== undefined && <Description>{description}</Description>}
    </Radio>
  );
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * What a chosen radio asks for, right under it and inside its RadioGroup, such as the address
 * of a server reached over HTTP. The group moves between radios on the arrow keys, wherever they
 * are pressed, so here they stay with the field being typed in.
 */
export function RadioDetails({ children }: { children: ReactNode }) {
  return (
    <div
      className="ms-7 flex flex-col gap-3"
      onKeyDown={(event) => {
        if (ARROWS.has(event.key)) event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

/** A value that is set elsewhere, where the control would be: "Set per workspace". */
export function ReadOnlySetting({
  label,
  description,
  value,
}: {
  label: string;
  description?: string;
  value: ReactNode;
}) {
  return (
    <div className="lk-setting-row flex items-start justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold">{label}</span>
        {description !== undefined && <span className="text-small text-muted">{description}</span>}
      </div>
      <span className="shrink-0 text-end">{value}</span>
    </div>
  );
}
