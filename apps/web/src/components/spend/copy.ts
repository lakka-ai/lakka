import type {
  BudgetAlertView,
  BudgetPeriod,
  RefusalCode,
  SpendPrincipalRow,
  SpendRouteRow,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import type { MeterState } from '../../lib/budget-meter.ts';
import { formatDay } from '../../lib/format.ts';
import { joinList } from '../../lib/spend.ts';
import { routeLabel } from '../chat/copy.ts';
import type { Tone } from '../patterns/status-chip.tsx';
import type { IconName } from '../icons.tsx';

/*
 * The words the Spend screens use for what the api sends (docs/design/docs/copy.md): surfaces,
 * periods, cap states, how a model was picked, why a request was refused, and what became of an
 * alert.
 */

const SURFACE: Readonly<Record<string, { name: MessageKey; help: MessageKey }>> = {
  chat: { name: 'spend.surface.chat', help: 'spend.surface.chatHelp' },
  api: { name: 'spend.surface.api', help: 'spend.surface.apiHelp' },
  mcp: { name: 'spend.surface.mcp', help: 'spend.surface.mcpHelp' },
};

export const surfaceName = (key: string) =>
  SURFACE[key] === undefined ? key : t((SURFACE[key] as { name: MessageKey }).name);
export const surfaceHelp = (key: string) =>
  SURFACE[key] === undefined ? '' : t((SURFACE[key] as { help: MessageKey }).help);

/** Which surfaces were used, in a fixed order: "Chat, API and MCP". */
export function surfacesSentence(keys: readonly string[]): string {
  const used = ['chat', 'api', 'mcp'].filter((k) => keys.includes(k));
  return used.length === 0 ? t('spend.tile.noSurfaces') : joinList(used.map(surfaceName));
}

const PERIOD: Readonly<Record<BudgetPeriod, MessageKey>> = {
  daily: 'spend.period.daily',
  monthly: 'spend.period.monthly',
  none: 'spend.period.none',
};
/** The period inside a sentence: "of $1,000.00 every month". */
export const periodWords = (period: BudgetPeriod) => t(PERIOD[period]);

const RESETS: Readonly<Record<BudgetPeriod, MessageKey>> = {
  daily: 'spend.resets.daily',
  monthly: 'spend.resets.monthly',
  none: 'spend.resets.none',
};
/** The Resets column: "Every month", "Never". */
export const resetsWord = (period: BudgetPeriod) => t(RESETS[period]);

/** "Resets Oct 1." for a cap that resets, nothing for one that does not. */
export const resetsSentence = (periodEnd: string | null) =>
  periodEnd === null ? '' : t('spend.caps.resets', { date: formatDay(periodEnd) });

const STATE: Readonly<Record<MeterState, MessageKey>> = {
  healthy: 'spend.caps.state.healthy',
  low: 'spend.caps.state.low',
  exhausted: 'spend.caps.state.exhausted',
};
export const stateWord = (state: MeterState) => t(STATE[state]);

/** The chip colors for a cap's state; the word carries the meaning, never the color alone. */
/** A money state's chip: healthy, low or used up, each with an icon as well as its words. */
export const stateChip: Readonly<Record<MeterState | 'none', { tone: Tone; icon?: IconName }>> = {
  healthy: { tone: 'success', icon: 'check' },
  low: { tone: 'warning', icon: 'warning' },
  exhausted: { tone: 'danger', icon: 'error' },
  none: { tone: 'neutral' },
};

/** A person's or key's name, or what to call one that was removed (NF-P4). */
export function principalName(row: SpendPrincipalRow): string {
  if (row.label !== '') return row.label;
  return row.kind === 'key' ? t('spend.breakdown.removedKey') : t('spend.breakdown.removedPerson');
}

/** A By route row's two lines. */
export function routeLines(row: SpendRouteRow): { name: string; help: string } {
  switch (row.kind) {
    case 'route':
      return {
        name: row.label === '' ? t('spend.breakdown.route.removed') : routeLabel(row.label),
        help: row.modelName ?? '',
      };
    case 'default':
      return {
        name: t('spend.breakdown.route.default'),
        help: t('spend.breakdown.route.defaultHelp'),
      };
    case 'chosen':
      return {
        name: t('spend.breakdown.route.chosen'),
        help: t('spend.breakdown.route.chosenHelp'),
      };
    case 'pinned':
      return {
        name: t('spend.breakdown.route.pinned'),
        help: t('spend.breakdown.route.pinnedHelp'),
      };
  }
}

const REFUSAL: Readonly<Record<RefusalCode, MessageKey>> = {
  budget_exceeded: 'spend.outcomes.refusal.budget_exceeded',
  budget_unavailable: 'spend.outcomes.refusal.budget_unavailable',
  rate_limited: 'spend.outcomes.refusal.rate_limited',
  forbidden: 'spend.outcomes.refusal.forbidden',
  no_model: 'spend.outcomes.refusal.no_model',
  unsupported_input: 'spend.outcomes.refusal.unsupported_input',
};
export const refusalReason = (code: RefusalCode) => t(REFUSAL[code]);

/** What an alert was about: "Lina Berg's cap reached 80%". */
export function alertText(alert: BudgetAlertView): string {
  const percent = String(alert.percent);
  switch (alert.scope) {
    case 'instance':
      return t('spend.alerts.instanceReached', { percent });
    case 'workspace':
      return t('spend.alerts.workspaceReached', { percent });
    case 'member':
      return t('spend.alerts.memberReached', { name: alert.subject ?? '', percent });
    case 'key':
      return t('spend.alerts.keyReached', { name: alert.subject ?? '', percent });
  }
}

/** Why an alert or a test alert did not arrive, from our own error code (BG-10). */
export function deliveryReason(code: string | null): string {
  if (code === null) return '';
  if (code === 'private_address') return t('spend.alerts.reason.private');
  if (code === 'timeout' || code === 'etimedout') return t('spend.alerts.reason.timeout');
  const status = /^http_(\d{3})$/.exec(code);
  if (status !== null) {
    return Number(status[1]) >= 500
      ? t('spend.alerts.reason.server')
      : t('spend.alerts.reason.refused');
  }
  return t('spend.alerts.reason.network');
}

/** What became of an alert, as a chip and, when it failed, why. */
export function alertResult(alert: BudgetAlertView): {
  word: string;
  tone: 'success' | 'danger' | 'none';
  why: string;
} {
  switch (alert.state) {
    case 'delivered':
      return { word: t('spend.alerts.delivered'), tone: 'success', why: '' };
    case 'failed':
      return {
        word: t('spend.alerts.notDelivered'),
        tone: 'danger',
        why: deliveryReason(alert.lastError),
      };
    case 'no_destination':
      return { word: t('spend.alerts.nowhere'), tone: 'none', why: t('spend.alerts.nowhereHelp') };
    case 'pending':
    case 'enqueued':
      return {
        word: t('spend.alerts.sending'),
        tone: 'none',
        why: alert.lastError === null ? '' : deliveryReason(alert.lastError),
      };
  }
}

const time = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** "Sep 28, 09:14 UTC", as copy.md writes a date with a time. */
export function formatWhen(iso: string): string {
  return t('spend.alerts.at', { date: formatDay(iso), time: time.format(new Date(iso)) });
}
