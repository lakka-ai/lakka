import type {
  CatalogueFeedView,
  ModelView,
  ProviderConfigView,
  ProviderTestStatus,
  RetentionRunCounts,
  SignInMethodView,
  SpendRow,
  SpendWorkspaceRow,
  UserAdminView,
  WorkspaceView,
} from '@lakka/contracts';
import { t } from '../i18n/index.ts';
import { formatClock, formatDay, formatDateTime } from './format.ts';
import { formatMicroUsd } from './money.ts';
import { formatCount } from './spend.ts';
import { roleLabel } from './roles.ts';

/*
 * What the instance admin pages work out in the browser (ADR 0097): finding and paging people,
 * the words for when someone was last active, whether a model's provider key works, what price
 * updates last did, and each workspace's admins, people and spend.
 */

/** People a search matches, by name or email, ignoring case. */
export function findPeople(people: readonly UserAdminView[], query: string): UserAdminView[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...people];
  return people.filter(
    (p) => p.displayName.toLowerCase().includes(q) || (p.email ?? '').includes(q),
  );
}

export const PEOPLE_PER_PAGE = 20;

export interface Page<Row> {
  rows: Row[];
  /** 1-based, for "Showing 1 to 20 of 31"; 0 when there are none. */
  from: number;
  to: number;
  total: number;
  /** The page shown, moved back when the list got shorter than the page asked for. */
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export function pageOf<Row>(rows: readonly Row[], page: number, size: number): Page<Row> {
  const last = Math.max(0, Math.ceil(rows.length / size) - 1);
  const shown = Math.min(Math.max(0, page), last);
  const start = shown * size;
  const slice = rows.slice(start, start + size);
  return {
    rows: slice,
    from: slice.length === 0 ? 0 : start + 1,
    to: start + slice.length,
    total: rows.length,
    page: shown,
    hasPrevious: shown > 0,
    hasNext: shown < last,
  };
}

const DAY_MS = 86_400_000;
const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);

/** "Today", "Yesterday", "Sep 27", or "Not yet" (copy.md, Dates). In UTC, like every date here. */
export function lastActiveWords(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return t('admin.people.notYet');
  const ago = utcDay(now) - utcDay(new Date(iso));
  if (ago <= 0) return t('admin.people.today');
  if (ago === 1) return t('admin.people.yesterday');
  return formatDay(iso);
}

/** How many workspaces a People row names before "and 4 more". */
const WORKSPACES_SHOWN = 3;

/** "Product: Admin. Design: Member." as the board writes it, the first three of them. */
export function workspacesLine(workspaces: UserAdminView['workspaces']): string {
  if (workspaces.length === 0) return t('admin.people.noWorkspace');
  const named = workspaces
    .slice(0, WORKSPACES_SHOWN)
    .map((w) => t('admin.people.workspaceRole', { name: w.name, role: roleLabel(w.role) }));
  const rest = workspaces.length - WORKSPACES_SHOWN;
  return [
    ...named,
    ...(rest > 0
      ? [t(rest === 1 ? 'admin.people.oneMore' : 'admin.people.more', { n: String(rest) })]
      : []),
  ].join(' ');
}

export function signInWords(methods: readonly SignInMethodView[]): string {
  if (methods.length === 0) return t('admin.people.noSignIn');
  return methods
    .map((m) =>
      m.kind === 'password'
        ? t('admin.people.password')
        : (m.displayName ?? t('admin.people.removedProvider')),
    )
    .join(', ');
}

/**
 * Whether a model can be used with the instance's key, from its provider's last check (Models
 * board, Status). A workspace may still use it with its own key.
 */
export type ModelStatus = 'available' | 'refused' | 'failed' | 'unchecked' | 'noKey';

export function instanceProviderFor(
  model: Pick<ModelView, 'provider'>,
  providers: readonly ProviderConfigView[],
): ProviderConfigView | undefined {
  return providers.find((p) => p.workspaceId === null && p.name === model.provider);
}

export function modelStatus(
  model: Pick<ModelView, 'provider'>,
  providers: readonly ProviderConfigView[],
): ModelStatus {
  const provider = instanceProviderFor(model, providers);
  // An OpenAI-compatible endpoint may need no key; a first-party provider always does.
  if (provider === undefined || (provider.kind !== 'openai-compatible' && !provider.hasKey)) {
    return 'noKey';
  }
  const status: ProviderTestStatus | undefined = provider.lastTest?.status;
  if (status === undefined) return 'unchecked';
  if (status === 'ok') return 'available';
  if (status === 'auth_failed') return 'refused';
  return 'failed';
}

/** What a model can read, as the Reads column says it: "Images, PDFs" or "Text". */
export function readsWords(capabilities: ModelView['capabilities']): string {
  const reads = [
    ...(capabilities.vision ? [t('admin.models.images')] : []),
    ...(capabilities.pdf ? [t('admin.models.pdfs')] : []),
  ];
  return reads.length === 0 ? t('admin.models.text') : reads.join(', ');
}

/**
 * A price per million tokens with at least cents, as the Models board shows it: 3000000 ->
 * "$3.00", 75000 -> "$0.075".
 */
export function formatPrice(micro: number): string {
  const whole = Math.floor(micro / 1_000_000);
  const fraction = String(micro % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `$${whole.toLocaleString('en')}.${fraction}`;
}

/** A price as the dialog's field holds it: "3.00" without the sign. */
export const priceField = (micro: number) => formatPrice(micro).slice(1).replaceAll(',', '');

/** How long a retention run took, in whole seconds: "42 seconds", "under a second". */
export function tookWords(ms: number): string {
  if (ms < 1000) return t('admin.retention.underASecond');
  const s = Math.round(ms / 1000);
  return s === 1 ? t('admin.retention.oneSecond') : t('admin.retention.seconds', { n: String(s) });
}

/** A count from the last run; a run from an older version has none for kinds added since. */
export function removedWords(n: number | null): string {
  return n === null ? t('admin.retention.notCounted') : formatCount(n);
}

/** Everything a run removed, counting only what it counted. */
export function runTotal(counts: RetentionRunCounts): number {
  return Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

/** A row of the Workspaces table. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  /** Names, in the order the people list has them. */
  admins: string[];
  people: number;
  spentMicroUsd: string;
  createdAt: string;
}

/**
 * Each workspace with its admins and people, from the people list, and what it spent, from
 * this month's instance report, so the numbers match People and Instance spend (ADR 0102).
 * Oldest first, as the board lists them.
 */
export function workspaceSummaries(
  workspaces: readonly WorkspaceView[],
  people: readonly UserAdminView[],
  spent: readonly SpendRow[],
): WorkspaceSummary[] {
  const present = people.filter((p) => p.status !== 'deleted');
  return workspaces
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
    .map((w) => {
      const roles = present.flatMap((p) =>
        p.workspaces.filter((m) => m.id === w.id).map((m) => ({ person: p.displayName, ...m })),
      );
      return {
        id: w.id,
        name: w.name,
        admins: roles.filter((m) => m.role === 'admin').map((m) => m.person),
        people: roles.length,
        spentMicroUsd: spent.find((row) => row.key === w.id)?.costMicroUsd ?? '0',
        createdAt: w.createdAt,
      };
    });
}

/** "3 workspaces. 31 people in total, 2 of them in more than one workspace." */
export function workspacesCountLine(
  workspaces: readonly WorkspaceView[],
  people: readonly UserAdminView[],
): string {
  const ids = new Set(workspaces.map((w) => w.id));
  const counts = people
    .filter((p) => p.status !== 'deleted')
    .map((p) => p.workspaces.filter((m) => ids.has(m.id)).length)
    .filter((n) => n > 0);
  const shared = counts.filter((n) => n > 1).length;
  const count =
    workspaces.length === 1
      ? t('admin.workspaces.countOne')
      : t('admin.workspaces.count', { n: String(workspaces.length) });
  const total =
    counts.length === 1
      ? t('admin.workspaces.peopleOne')
      : shared === 0
        ? t('admin.workspaces.people', { n: String(counts.length) })
        : t('admin.workspaces.peopleShared', {
            n: String(counts.length),
            shared: String(shared),
          });
  return `${count} ${total}`;
}

/**
 * The second half of the line under the Workspaces table. The table's spend matches Instance
 * spend until a workspace with spend this month is deleted: its spend stays in the instance's
 * report (ADR 0104) but its row leaves the table, so the line then says how much that is.
 */
export function workspacesSpendLine(byWorkspace: readonly SpendWorkspaceRow[]): string {
  const deleted = byWorkspace
    .filter((row) => row.deleted)
    .reduce((sum, row) => sum + BigInt(row.costMicroUsd), 0n);
  return deleted === 0n
    ? t('admin.workspaces.spendMatches')
    : t('admin.workspaces.spendDeleted', { amount: formatMicroUsd(String(deleted)) });
}

/** Price updates' switch (PR-6, ADR 0116): hidden when an operator locked it off, else why not. */
export function priceFeedSwitch(feed: CatalogueFeedView): {
  shown: boolean;
  blockedReason: string | undefined;
} {
  if (feed.unavailable === 'locked') return { shown: false, blockedReason: undefined };
  return {
    shown: true,
    blockedReason: feed.unavailable === 'no_key' ? t('admin.models.feed.noKey') : undefined,
  };
}

/** "Turned on by Maja Lind on Oct 6, 09:14.", or nothing when nobody has switched it yet. */
export function priceFeedChangedWords(feed: CatalogueFeedView): string | undefined {
  if (feed.changedBy === null || feed.changedAt === null) return undefined;
  return t(feed.enabled ? 'admin.models.feed.turnedOnBy' : 'admin.models.feed.turnedOffBy', {
    name: feed.changedBy,
    date: formatDateTime(feed.changedAt),
  });
}

const FEED_FAILURES = {
  unreachable: 'admin.models.feed.failed.unreachable',
  timeout: 'admin.models.feed.failed.timeout',
  http_status: 'admin.models.feed.failed.http_status',
  too_large: 'admin.models.feed.failed.too_large',
  invalid_feed: 'admin.models.feed.failed.invalid_feed',
  unknown_key: 'admin.models.feed.failed.unknown_key',
  bad_signature: 'admin.models.feed.failed.bad_signature',
  not_newer: 'admin.models.feed.failed.not_newer',
  too_many_models: 'admin.models.feed.failed.too_many_models',
  untrusted_provider: 'admin.models.feed.failed.untrusted_provider',
  zero_price: 'admin.models.feed.failed.zero_price',
  tier_lowers_price: 'admin.models.feed.failed.tier_lowers_price',
  price_drop: 'admin.models.feed.failed.price_drop',
} as const;

/**
 * The last check in plain words: when, and what it found. A refused list says why and that the
 * prices stayed as they were.
 */
export function priceFeedCheckWords(feed: CatalogueFeedView, now: Date = new Date()): string {
  if (feed.lastCheckedAt === null) return t('admin.models.feed.notChecked');
  const when = t('admin.models.feed.checked', {
    day: lastActiveWords(feed.lastCheckedAt, now),
    time: formatClock(feed.lastCheckedAt),
  });
  if (feed.lastResult === 'applied') return `${when} ${t('admin.models.feed.applied')}`;
  if (feed.lastResult === 'unchanged') return `${when} ${t('admin.models.feed.unchanged')}`;
  const why =
    feed.lastErrorCode === null
      ? t('admin.models.feed.failed.unknown')
      : t(FEED_FAILURES[feed.lastErrorCode]);
  return `${when} ${why} ${t('admin.models.feed.keptPrices')}`;
}

/** Whose prices apply: when a price update last changed them, or the release's. */
export function priceFeedPricesWords(feed: CatalogueFeedView, now: Date = new Date()): string {
  if (feed.activeSerial === feed.bundledSerial || feed.appliedAt === null) {
    return t('admin.models.feed.releasePrices');
  }
  return t('admin.models.feed.lastChange', {
    day: lastActiveWords(feed.appliedAt, now),
    time: formatClock(feed.appliedAt),
  });
}
