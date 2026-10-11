import { useEffect, useId, useRef } from 'react';
import { Switch } from '@heroui/react';

/*
 * A tool's Enabled or Asks first switch (Pattern 12: a Switch is for a change that applies at
 * once), also used for Price updates on the Models page. Its own file, without the api, so the
 * pattern gallery can show it.
 */
export function ToolSwitch({
  label,
  isSelected,
  disabledReason,
  describedBy,
  onChange,
}: {
  label: string;
  isSelected: boolean;
  /** Set when the switch cannot be used: it stays focusable and says why. */
  disabledReason?: string;
  /** The id of a description shown beside the switch, read after its name. */
  describedBy?: string;
  onChange: (on: boolean) => void;
}) {
  const reasonId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const blocked = disabledReason !== undefined;
  // react-aria takes no aria-disabled for a switch, so it goes on the input itself: the switch
  // stays focusable and says why it cannot change (accessibility.md, Tools).
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    if (blocked) input.setAttribute('aria-disabled', 'true');
    else input.removeAttribute('aria-disabled');
  }, [blocked]);
  return (
    <>
      <Switch
        isSelected={isSelected}
        onChange={(on) => {
          if (!blocked) onChange(on);
        }}
        aria-label={label}
        inputRef={inputRef}
        {...(blocked || describedBy !== undefined
          ? {
              'aria-describedby': [describedBy, blocked ? reasonId : undefined]
                .filter((id) => id !== undefined)
                .join(' '),
            }
          : {})}
        className={blocked ? 'opacity-50' : ''}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
      {blocked && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}
    </>
  );
}
