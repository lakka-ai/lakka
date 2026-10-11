import { useSuspenseQuery } from '@tanstack/react-query';
import type { RequestOutcome } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { requestableQuery } from '../../lib/queries.ts';
import { OUTCOME } from '../../lib/traces.ts';
import type { Names } from '../../lib/traces.ts';
import { modelLabel, providerLabel } from '../chat/copy.ts';
import { StatusChip } from '../patterns/status-chip.tsx';
import type { Tone } from '../patterns/status-chip.tsx';
import type { IconName } from '../icons.tsx';

/*
 * What the Requests list and a trace share (OB-1, ADR 0095): names for models, routes and
 * providers, times, and the outcome chip.
 */

/**
 * Names for people: models as chat names them (CH-2), routes by the names the api gave with the
 * trace, providers as chat names them.
 */
export function useNames(
  workspaceId: string,
  routes: readonly { id: string; name: string }[] = [],
): Names {
  const { data: requestable } = useSuspenseQuery(requestableQuery(workspaceId));
  const models = new Map(requestable.models.map((m) => [m.id, m.displayName]));
  const routeNames = new Map(routes.map((r) => [r.id, r.name]));
  return {
    model: (ref) => models.get(ref) ?? modelLabel(ref),
    route: (id) => routeNames.get(id) ?? null,
    provider: providerLabel,
  };
}

const clock = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** "Sep 28, 14:32:07", in UTC like every time here. */
export const formatTime = (iso: string) => clock.format(new Date(iso));

const CHIP: Readonly<Record<RequestOutcome, { tone: Tone; icon: IconName }>> = {
  completed: { tone: 'success', icon: 'check' },
  cheaper: { tone: 'cheaper', icon: 'cheaper' },
  refused: { tone: 'refused', icon: 'ban' },
  stopped: { tone: 'neutral', icon: 'stop' },
  failed: { tone: 'danger', icon: 'error' },
};

/**
 * An outcome as a chip. The trace page's header chip draws its icon too; it is the one chip
 * size, as every chip is (ADR 0108).
 */
export function OutcomeChip({
  kind,
  words,
  withIcon = false,
}: {
  kind: RequestOutcome;
  words?: string;
  withIcon?: boolean;
}) {
  return (
    <StatusChip tone={CHIP[kind].tone} {...(withIcon ? { icon: CHIP[kind].icon } : {})}>
      {words ?? t(OUTCOME[kind])}
    </StatusChip>
  );
}
