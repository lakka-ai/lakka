import { describe, expect, it } from 'vitest';
import type {
  CatalogueFeedView,
  ProviderConfigView,
  UserAdminView,
  WorkspaceView,
} from '@lakka/contracts';
import { parsePeriods } from '../src/components/admin/retention.tsx';
import {
  findPeople,
  formatPrice,
  lastActiveWords,
  modelStatus,
  pageOf,
  priceFeedChangedWords,
  priceFeedCheckWords,
  priceFeedPricesWords,
  priceFeedSwitch,
  priceField,
  readsWords,
  removedWords,
  runTotal,
  signInWords,
  tookWords,
  workspacesCountLine,
  workspacesSpendLine,
  workspacesLine,
  workspaceSummaries,
} from '../src/lib/admin.ts';
import { formatDayAndYear } from '../src/lib/format.ts';

const person = (over: Partial<UserAdminView>): UserAdminView => ({
  id: 'p',
  displayName: 'Maja Lind',
  email: 'maja@nordlys.se',
  status: 'active',
  isInstanceAdmin: false,
  createdAt: '2026-09-01T00:00:00Z',
  workspaces: [],
  signsInWith: [],
  lastActiveAt: null,
  ...over,
});

const provider = (over: Partial<ProviderConfigView>): ProviderConfigView => ({
  id: 'c',
  workspaceId: null,
  kind: 'anthropic',
  name: 'anthropic',
  baseUrl: null,
  hasKey: true,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  lastTest: null,
  ...over,
});

/** A workspace's row in the instance spend report. */
const spendRow = (key: string, cost: string, deleted: boolean) => ({
  key,
  label: key,
  costMicroUsd: cost,
  requests: 1,
  cap: null,
  deleted,
});

describe('People (ID-6, ADR 0097)', () => {
  const people = [
    person({ id: '1', displayName: 'Maja Lind', email: 'maja@nordlys.se' }),
    person({ id: '2', displayName: 'Jonas Ek', email: 'jonas@nordlys.se' }),
    person({ id: '3', displayName: 'Anna Virtanen', email: 'anna@nordlys.fi' }),
  ];

  it('ID-6: finds people by part of a name or an email, ignoring case', () => {
    expect(findPeople(people, 'JONAS').map((p) => p.id)).toEqual(['2']);
    expect(findPeople(people, 'nordlys.fi').map((p) => p.id)).toEqual(['3']);
    expect(findPeople(people, '  ')).toHaveLength(3);
    expect(findPeople(people, 'nobody')).toEqual([]);
  });

  it('ID-6: pages a list, and moves back when it got shorter than the page asked for', () => {
    const rows = Array.from({ length: 31 }, (_, i) => i);
    expect(pageOf(rows, 0, 20)).toMatchObject({
      from: 1,
      to: 20,
      total: 31,
      hasPrevious: false,
      hasNext: true,
    });
    expect(pageOf(rows, 1, 20)).toMatchObject({
      from: 21,
      to: 31,
      hasPrevious: true,
      hasNext: false,
    });
    expect(pageOf(rows.slice(0, 5), 1, 20)).toMatchObject({ page: 0, from: 1, to: 5 });
    expect(pageOf([], 0, 20)).toMatchObject({ from: 0, to: 0, hasNext: false });
  });

  it('ID-6: says when someone was last active as copy.md writes dates, in UTC', () => {
    const now = new Date('2026-09-28T10:00:00Z');
    expect(lastActiveWords('2026-09-28T00:05:00Z', now)).toBe('Today');
    expect(lastActiveWords('2026-09-27T23:59:00Z', now)).toBe('Yesterday');
    expect(lastActiveWords('2026-09-02T12:00:00Z', now)).toBe('Sep 2');
    expect(lastActiveWords(null, now)).toBe('Not yet');
  });

  it('ID-6: names workspaces with roles, and how a person signs in', () => {
    expect(
      workspacesLine([
        { id: 'a', name: 'Product', role: 'admin' },
        { id: 'b', name: 'Design', role: 'member' },
      ]),
    ).toBe('Product: Admin. Design: Member.');
    expect(workspacesLine([])).toBe('No workspace yet');
    const many = ['A', 'B', 'C', 'D', 'E'].map((name) => ({
      id: name,
      name,
      role: 'member' as const,
    }));
    expect(workspacesLine(many)).toBe('A: Member. B: Member. C: Member. And 2 more.');
    expect(
      signInWords([
        { kind: 'password' },
        { kind: 'sso', providerId: 'keycloak', displayName: 'Nordlys SSO' },
      ]),
    ).toBe('Password, Nordlys SSO');
    expect(signInWords([{ kind: 'sso', providerId: 'gone', displayName: null }])).toBe(
      'A removed provider',
    );
  });
});

describe('Models (PR-5, PR-7, ADR 0097)', () => {
  it("PR-8: a model's status is its provider's last check with the instance key", () => {
    const model = { provider: 'anthropic' };
    expect(modelStatus(model, [])).toBe('noKey');
    expect(modelStatus(model, [provider({ hasKey: false })])).toBe('noKey');
    expect(modelStatus(model, [provider({})])).toBe('unchecked');
    const tested = (status: 'ok' | 'auth_failed' | 'unreachable' | 'error') =>
      provider({ lastTest: { status, httpStatus: null, testedAt: '2026-09-28T10:00:00Z' } });
    expect(modelStatus(model, [tested('ok')])).toBe('available');
    expect(modelStatus(model, [tested('auth_failed')])).toBe('refused');
    expect(modelStatus(model, [tested('unreachable')])).toBe('failed');
    // A workspace's own key says nothing of the instance's.
    expect(modelStatus(model, [{ ...tested('ok'), workspaceId: 'w' }])).toBe('noKey');
  });

  it('PR-8: a local endpoint needs no key to be available', () => {
    const ollama = provider({
      kind: 'openai-compatible',
      name: 'ollama',
      hasKey: false,
      lastTest: { status: 'ok', httpStatus: 200, testedAt: '2026-09-28T10:00:00Z' },
    });
    expect(modelStatus({ provider: 'ollama' }, [ollama])).toBe('available');
  });

  it('PR-7: prices show at least cents, and what a model reads is said in words', () => {
    expect(formatPrice(3_000_000)).toBe('$3.00');
    expect(formatPrice(400_000)).toBe('$0.40');
    expect(formatPrice(75_000)).toBe('$0.075');
    expect(formatPrice(0)).toBe('$0.00');
    expect(priceField(1_250_000_000)).toBe('1250.00');
    const none = {
      vision: false,
      pdf: false,
      tools: true,
      structuredOutput: false,
      promptCaching: false,
      reasoning: false,
    };
    expect(readsWords({ ...none, vision: true, pdf: true })).toBe('Images, PDFs');
    expect(readsWords(none)).toBe('Text');
  });
});

describe('Retention (OB-6, NF-P5)', () => {
  const texts = {
    spansDays: '30',
    usageMonths: '13',
    conversationsDays: '',
    toolAuditDays: '90',
    budgetAlertsMonths: '13',
    reservationsDays: '30',
  };

  it('NF-P5: an empty conversations period keeps conversations until people delete them', () => {
    expect(parsePeriods(texts)).toEqual({
      body: {
        spansDays: 30,
        usageMonths: 13,
        conversationsDays: null,
        toolAuditDays: 90,
        budgetAlertsMonths: 13,
        reservationsDays: 30,
      },
    });
  });

  it('OB-6: names every period that is not a whole number within its limits', () => {
    expect(
      parsePeriods({ ...texts, usageMonths: '1', spansDays: '2.5', toolAuditDays: '' }),
    ).toEqual({
      wrong: ['spansDays', 'usageMonths', 'toolAuditDays'],
    });
  });

  it('OB-6: says how long a run took in whole seconds', () => {
    expect(tookWords(420)).toBe('under a second');
    expect(tookWords(1_200)).toBe('1 second');
    expect(tookWords(42_300)).toBe('42 seconds');
  });

  it('OB-6: a run from an older version shows no number for a kind it did not count', () => {
    expect(removedWords(1_204)).toBe('1,204');
    expect(removedWords(0)).toBe('0');
    expect(removedWords(null)).toBe('Not counted');
  });

  it('NF-P5: a run total adds what was counted, expired reset links included', () => {
    const counts = {
      spans: 10,
      spanContent: 0,
      usage: 0,
      conversations: 0,
      toolRecords: 0,
      budgetAlerts: 0,
      reservations: 3,
      oauthStates: 1,
      passwordResets: 2,
    };
    expect(runTotal(counts)).toBe(16);
    expect(runTotal({ ...counts, passwordResets: null })).toBe(14);
  });
});

const ws = (id: string, name: string, createdAt: string): WorkspaceView => ({
  id,
  name,
  slug: name.toLowerCase(),
  role: null,
  createdAt,
});

describe('Workspaces (ID-3, ADR 0102)', () => {
  const product = ws('w1', 'Product', '2026-03-04T09:00:00Z');
  const design = ws('w2', 'Design', '2026-04-18T09:00:00Z');
  const support = ws('w3', 'Support', '2026-06-02T09:00:00Z');
  const people = [
    person({
      id: 'maja',
      displayName: 'Maja Lind',
      workspaces: [
        { id: 'w2', name: 'Design', role: 'admin' },
        { id: 'w1', name: 'Product', role: 'admin' },
      ],
    }),
    person({
      id: 'jonas',
      displayName: 'Jonas Ek',
      workspaces: [{ id: 'w1', name: 'Product', role: 'admin' }],
    }),
    person({
      id: 'per',
      displayName: 'Per Olsen',
      status: 'suspended',
      workspaces: [{ id: 'w1', name: 'Product', role: 'member' }],
    }),
    person({
      id: 'gone',
      displayName: 'Gone',
      status: 'deleted',
      workspaces: [{ id: 'w3', name: 'Support', role: 'admin' }],
    }),
    person({ id: 'lone', displayName: 'Lone' }),
  ];

  it('ID-3: each workspace has its admins by name, its people and its spend, oldest first', () => {
    const rows = workspaceSummaries([support, design, product], people, [
      { key: 'w1', label: 'Product', costMicroUsd: '999600000', requests: 12 },
    ]);
    expect(rows.map((r) => [r.name, r.admins, r.people, r.spentMicroUsd])).toEqual([
      ['Product', ['Maja Lind', 'Jonas Ek'], 3, '999600000'],
      ['Design', ['Maja Lind'], 1, '0'],
      // A deleted person is no longer in it.
      ['Support', [], 0, '0'],
    ]);
  });

  it('ID-3: counts workspaces, and people once however many workspaces they are in', () => {
    expect(workspacesCountLine([product, design, support], people)).toBe(
      '3 workspaces. 3 people in total, 1 of them in more than one workspace.',
    );
    expect(workspacesCountLine([design], people)).toBe('1 workspace. 1 person in total.');
    expect(workspacesCountLine([product], people)).toBe('1 workspace. 3 people in total.');
  });

  it('ID-8: the line under the table says how much of Instance spend is from deleted workspaces', () => {
    expect(workspacesSpendLine([spendRow('product', '999600000', false)])).toBe(
      'Spend matches Instance spend.',
    );
    expect(
      workspacesSpendLine([
        spendRow('product', '999600000', false),
        spendRow('old', '12500000', true),
        spendRow('older', '0', true),
      ]),
    ).toBe('Instance spend also includes $12.50 from deleted workspaces.');
  });

  it('says when a workspace was created with its year', () => {
    expect(formatDayAndYear(product.createdAt)).toBe('Mar 4, 2026');
  });
});

const feed = (over: Partial<CatalogueFeedView> = {}): CatalogueFeedView => ({
  enabled: false,
  unavailable: null,
  host: 'raw.githubusercontent.com',
  changedBy: null,
  changedAt: null,
  lastCheckedAt: null,
  lastResult: null,
  lastErrorCode: null,
  appliedSerial: null,
  appliedAt: null,
  bundledSerial: 4,
  activeSerial: 4,
  checkRequested: false,
  ...over,
});

describe('price updates (PR-6, ADR 0116)', () => {
  const NOW = new Date('2026-10-06T15:00:00Z');

  it('PR-6: the switch hides when the operator locked it, and says why it cannot be used without a key', () => {
    expect(priceFeedSwitch(feed())).toEqual({ shown: true, blockedReason: undefined });
    expect(priceFeedSwitch(feed({ unavailable: 'locked', host: null })).shown).toBe(false);
    expect(priceFeedSwitch(feed({ unavailable: 'no_key' }))).toEqual({
      shown: true,
      blockedReason: 'This build has no price feed key, so price updates cannot be turned on.',
    });
  });

  it('PR-6: says what the last check found, and that a refused list changed nothing', () => {
    expect(priceFeedCheckWords(feed(), NOW)).toBe('Not checked yet.');
    const checked = { lastCheckedAt: '2026-10-06T10:02:00Z' };
    expect(priceFeedCheckWords(feed({ ...checked, lastResult: 'applied' }), NOW)).toBe(
      'Last checked: Today at 10:02 UTC. New prices were applied.',
    );
    expect(priceFeedCheckWords(feed({ ...checked, lastResult: 'unchanged' }), NOW)).toBe(
      'Last checked: Today at 10:02 UTC. There were no new prices.',
    );
    expect(
      priceFeedCheckWords(
        feed({ ...checked, lastResult: 'failed', lastErrorCode: 'bad_signature' }),
        NOW,
      ),
    ).toBe(
      'Last checked: Today at 10:02 UTC. The signature did not match, so the price list may have been changed. It was refused. Prices stay as they were, and the server tries again tomorrow.',
    );
  });

  it('PR-6: says whose prices apply, and who last switched it', () => {
    expect(priceFeedPricesWords(feed(), NOW)).toBe('The prices that came with this release apply.');
    expect(
      priceFeedPricesWords(
        feed({
          enabled: true,
          activeSerial: 5,
          appliedSerial: 5,
          appliedAt: '2026-10-05T03:17:00Z',
        }),
        NOW,
      ),
    ).toBe('Prices last changed: Yesterday at 03:17 UTC.');
    // Off, a stored update no longer applies.
    expect(
      priceFeedPricesWords(feed({ appliedSerial: 5, appliedAt: '2026-10-05T03:17:00Z' }), NOW),
    ).toBe('The prices that came with this release apply.');
    expect(priceFeedChangedWords(feed())).toBeUndefined();
    expect(
      priceFeedChangedWords(
        feed({ enabled: true, changedBy: 'Maja Lind', changedAt: '2026-10-06T09:14:00Z' }),
      ),
    ).toBe('Turned on by Maja Lind on Oct 6, 2026, 09:14 UTC.');
  });
});
