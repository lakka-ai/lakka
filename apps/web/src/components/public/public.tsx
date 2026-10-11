import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { Button, Description, FieldError, Input, Label, TextField } from '@heroui/react';
import type { ComponentProps } from 'react';
import { t } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { Brand } from '../shell/brand.tsx';

/*
 * The signed-out pages (Public and Setup boards): the wordmark top left, one card in the middle,
 * and the AGPL notice under it, which the root document adds. Parts they share: the password
 * field with Show, the "or" between ways in, and the alert above a form.
 */

export function PublicPage({
  children,
  above,
  below,
  width = 'narrow',
}: {
  children: ReactNode;
  /** Over the card, such as setup's progress. */
  above?: ReactNode;
  /** Under the card, centered: a line about the steps, as on the setup boards. */
  below?: ReactNode;
  width?: 'narrow' | 'wide';
}) {
  return (
    <div className="flex flex-col gap-6 px-4 pt-8 pb-12 sm:px-10">
      <Brand />
      <main
        id="main"
        className={`mx-auto flex w-full flex-col gap-4 ${width === 'wide' ? 'max-w-140' : 'max-w-115 sm:mt-12'}`}
      >
        {above}
        <div className="flex flex-col gap-6 lk-card p-6 sm:p-8">{children}</div>
        {below !== undefined && <p className="text-center text-small text-muted">{below}</p>}
      </main>
    </div>
  );
}

/**
 * The page's heading. `focusOnMount` moves focus to it when it appears: after Continue in setup,
 * and on the one-action invite pages (accessibility.md).
 */
export function PublicHeading({
  children,
  focusOnMount = false,
}: {
  children: ReactNode;
  focusOnMount?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <h1 ref={ref} tabIndex={-1} className="lk-title outline-none">
      {children}
    </h1>
  );
}

/**
 * The 40px tile over a one-action page's heading (Public-Expired, Public-Member): a link that
 * does not work, or a step that is already done.
 */
export function PublicIcon({ tone }: { tone: 'danger' | 'success' }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-10 items-center justify-center rounded-note ${tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}
    >
      <Icon name={tone === 'danger' ? 'ban' : 'check'} className="size-5" />
    </span>
  );
}

/** "or", between signing in with a provider and with a password. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-small text-muted">
      <span aria-hidden="true" className="h-px grow bg-separator" />
      {t('public.or')}
      <span aria-hidden="true" className="h-px grow bg-separator" />
    </div>
  );
}

/** One alert above a form: what happened, then what to do (Pattern 3). */
export function FormAlert({ title, children }: { title: string; children?: ReactNode }) {
  return <ErrorNotice title={title}>{children}</ErrorNotice>;
}

type TextFieldProps = Omit<ComponentProps<typeof TextField>, 'children' | 'type'>;

/**
 * A password with a button beside it that says what it does: Show while the password is hidden,
 * Hide while it is shown. Its name changes rather than a pressed state, so a screen reader is not
 * told both (ADR 0098). Showing it changes only the input's type; the value stays where it is.
 */
export function PasswordField({
  label,
  description,
  error,
  autoComplete,
  inputRef,
  ...field
}: TextFieldProps & {
  label: string;
  description?: string;
  error?: string;
  autoComplete: 'current-password' | 'new-password';
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [shown, setShown] = useState(false);
  const inputId = useId();
  return (
    <TextField
      type={shown ? 'text' : 'password'}
      autoComplete={autoComplete}
      isInvalid={error !== undefined}
      {...field}
    >
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input id={inputId} ref={inputRef} spellCheck={false} className="min-w-0 grow" />
        <Button
          size="lg"
          variant="tertiary"
          aria-controls={inputId}
          onPress={() => setShown((s) => !s)}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} />
          {shown ? t('public.hide') : t('public.show')}
        </Button>
      </div>
      {error === undefined ? (
        description !== undefined && <Description>{description}</Description>
      ) : (
        <FieldError>{error}</FieldError>
      )}
    </TextField>
  );
}
