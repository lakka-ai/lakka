import { useSyncExternalStore } from 'react';
import type { ComponentProps } from 'react';
import { Button, Form } from '@heroui/react';

/*
 * Forms that never leak what was typed into them (invariant 9, NF-S5). Until the page has
 * hydrated, React has not attached its submit handlers, and a browser submitting the form
 * natively would send every field in the URL of a GET request: passwords, setup codes and API
 * keys would land in browser history and in any proxy's logs. So:
 *   - the form's method is POST, so even a native submission keeps fields out of the URL;
 *   - the submit button is disabled until hydration, so a native submission cannot happen;
 *   - the fields are disabled until hydration too, through a disabled fieldset, which works
 *     before any script runs. React resets controlled inputs to their state as it takes over,
 *     so anything typed earlier would silently vanish (ADR 0044).
 */

const subscribe = () => () => undefined;

/** False while the page is server-rendered or not yet hydrated, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export function SafeForm({ children, ...props }: ComponentProps<typeof Form>) {
  const hydrated = useHydrated();
  return (
    <Form {...props} method="post">
      {/* display: contents keeps the form's own layout for the fields inside. */}
      <fieldset disabled={!hydrated} className="contents">
        {children}
      </fieldset>
    </Form>
  );
}

export function SubmitButton({ isDisabled, ...props }: ComponentProps<typeof Button>) {
  const hydrated = useHydrated();
  return <Button {...props} type="submit" isDisabled={!hydrated || isDisabled === true} />;
}
