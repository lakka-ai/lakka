import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';

/*
 * First-run setup's three steps (AD-1, ADR 0034; Setup boards). What the steps share lives here,
 * in memory only: the setup code and the recovery key are secrets, so a reload starts again at
 * the code rather than keeping them in the browser's storage. Both go when the page leaves
 * /setup, as this provider unmounts.
 */

export const SETUP_STEPS = ['code', 'recoveryKey', 'account'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

const STEP_NAME: Readonly<Record<SetupStep, MessageKey>> = {
  code: 'setup.steps.code',
  recoveryKey: 'setup.steps.recoveryKey',
  account: 'setup.steps.account',
};

interface SetupState {
  code: string | null;
  recoveryKey: string | null;
  /** Set by Continue, so the next step moves focus to its heading; not on a first load. */
  moved: boolean;
  proved: (code: string, recoveryKey: string) => void;
  saved: () => void;
}

const SetupContext = createContext<SetupState | null>(null);

export function SetupProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const value = useMemo<SetupState>(
    () => ({
      code,
      recoveryKey,
      moved,
      proved: (c, k) => {
        setCode(c);
        setRecoveryKey(k);
        setMoved(true);
      },
      saved: () => setMoved(true),
    }),
    [code, recoveryKey, moved],
  );
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}

export function useSetup(): SetupState {
  const state = useContext(SetupContext);
  if (state === null) throw new Error('useSetup outside SetupProvider');
  return state;
}

/** Progress as an ordered list, with aria-current="step" on the current step. */
export function SetupSteps({ current }: { current: SetupStep }) {
  const at = SETUP_STEPS.indexOf(current);
  return (
    <nav aria-label={t('setup.steps.label')}>
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body">
        {SETUP_STEPS.map((step, i) => {
          const done = i < at;
          const here = i === at;
          return (
            <li
              key={step}
              {...(here ? { 'aria-current': 'step' as const } : {})}
              className="flex items-center gap-2"
            >
              {i > 0 && (
                <span aria-hidden="true" className="hidden h-px w-16 bg-separator sm:block" />
              )}
              <span
                aria-hidden="true"
                className={`flex size-6 items-center justify-center rounded-full text-caption font-semibold ${
                  done
                    ? 'bg-success-soft text-success-soft-foreground'
                    : here
                      ? 'bg-accent text-accent-foreground'
                      : 'border border-border text-muted'
                }`}
              >
                {done ? <Icon name="check" className="size-3.5" /> : i + 1}
              </span>
              <span className={here ? 'font-semibold' : done ? '' : 'text-muted'}>
                {t(STEP_NAME[step])}
                {done && <span className="sr-only">{t('setup.steps.done')}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
