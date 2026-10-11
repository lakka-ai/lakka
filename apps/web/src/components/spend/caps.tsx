import { useId } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import type {
  AppliedCapView,
  BudgetView,
  KeyView,
  MemberView,
  WorkspaceBudgetsView,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { readCap } from '../../lib/budget-meter.ts';
import type { MeterReading, MeterState } from '../../lib/budget-meter.ts';
import { formatDay } from '../../lib/format.ts';
import { formatMicroUsd } from '../../lib/money.ts';
import { capReading, joinAndPercents, joinList } from '../../lib/spend.ts';
import { CapMeter, stateLook } from '../patterns/budget-meter.tsx';
import { CardSection } from '../patterns/card-section.tsx';
import { DataTable, TwoLine } from '../patterns/data-table.tsx';
import type { Column } from '../patterns/data-table.tsx';
import { periodWords, resetsSentence, resetsWord, stateChip, stateWord } from './copy.ts';
import { Icon } from '../icons.tsx';
import { StatusChip } from '../patterns/status-chip.tsx';

/*
 * Caps (BG-1, BG-9; Spend-Budgets and Spend-Member boards). Meters show what is left, and low
 * or used up is said in words as well as color (Pattern 2); each meter's aria-valuetext names
 * what is left, the cap and when it resets. Edit cap buttons carry the person's or key's name.
 * A member's own caps come from the api already filtered to theirs (F5).
 */

function StateChip({ state }: { state: MeterState | 'none' }) {
  return (
    <StatusChip {...stateChip[state]}>
      {state === 'none' ? t('spend.caps.noCap') : stateWord(state)}
    </StatusChip>
  );
}

/** A cap as the meter reads it, named for its aria-valuetext. */
function reading(budget: BudgetView, name: string): MeterReading {
  return readCap(
    capReading(budget, {
      name,
      period: periodWords(budget.period),
      ...(budget.periodEnd === null
        ? {}
        : { resets: t('chat.cap.resets', { date: formatDay(budget.periodEnd) }) }),
    }),
  );
}

/** A workspace's own cap in a table row: "$0.40 left of $1,000.00", or "No cap". */
export function CapLeftChip({ cap, name }: { cap: BudgetView | null; name: string }) {
  if (cap === null) return <StateChip state="none" />;
  const r = reading(cap, name);
  return (
    <StatusChip {...stateChip[r.state]} className="lk-num">
      {t('spend.caps.leftOf', {
        left: formatMicroUsd(String(r.leftMicro)),
        limit: formatMicroUsd(cap.limitMicroUsd),
      })}
    </StatusChip>
  );
}

interface CapCardCopy {
  title: string;
  noCap: string;
  noCapBody: string;
  set: string;
  edit: string;
  /** Who else the cap covers, after its alerts. */
  covers: string;
  /** Instead of the edit button, for someone who may not change it. */
  readOnly: string;
  /** The board shows Healthy on the instance cap, and no chip on a healthy workspace cap. */
  alwaysChip: boolean;
}

function CapCard({
  copy,
  cap,
  canEdit,
  onEdit,
}: {
  copy: CapCardCopy;
  cap: BudgetView | null;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const id = useId();
  if (cap === null) {
    return (
      <CardSection title={copy.noCap} subtitle={copy.noCapBody} titleId={id}>
        {canEdit ? (
          <Button size="lg" variant="primary" className="self-start" onPress={onEdit}>
            <Icon name="plus" />
            {copy.set}
          </Button>
        ) : (
          <p className="text-small text-muted">{copy.readOnly}</p>
        )}
      </CardSection>
    );
  }
  const r = reading(cap, copy.title);
  return (
    <section
      aria-labelledby={id}
      className={`flex flex-col gap-3 lk-card p-5 sm:flex-row sm:items-center ${stateLook[r.state].edge} ${r.state === 'low' ? 'bg-warning-soft/40' : ''}`}
    >
      <div className="flex min-w-0 grow flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={id} className="text-heading">
            {copy.title}
          </h2>
          {(copy.alwaysChip || r.state !== 'healthy') && <StateChip state={r.state} />}
        </div>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="lk-num text-stat">
            {t('spend.caps.workspaceLeft', { left: formatMicroUsd(String(r.leftMicro)) })}
          </span>
          <span className="lk-num text-small text-muted">
            {t('spend.caps.workspaceDetail', {
              limit: formatMicroUsd(cap.limitMicroUsd),
              period: periodWords(cap.period),
              used: formatMicroUsd(cap.spentMicroUsd),
            })}{' '}
            {resetsSentence(cap.periodEnd)}
          </span>
        </p>
        <div className="max-w-xl">
          <CapMeter reading={r} />
        </div>
        <p className="text-small text-muted">
          {cap.alertPercents.length === 0
            ? t('spend.caps.noAlerts')
            : t('spend.caps.alertsAt', { list: joinAndPercents(cap.alertPercents) })}{' '}
          {copy.covers}
        </p>
      </div>
      {canEdit ? (
        <Button size="lg" variant="primary" className="self-start sm:self-center" onPress={onEdit}>
          <Icon name="pencil" />
          {copy.edit}
        </Button>
      ) : (
        <p className="text-small text-muted sm:max-w-48">{copy.readOnly}</p>
      )}
    </section>
  );
}

export function WorkspaceCapCard({
  workspaceName,
  cap,
  canEdit,
  onEdit,
}: {
  workspaceName: string;
  cap: BudgetView | null;
  /** Instance admins set the workspace cap (Q1). */
  canEdit: boolean;
  onEdit: () => void;
}) {
  return (
    <CapCard
      copy={{
        title: t('spend.caps.workspace'),
        noCap: t('spend.caps.noWorkspaceCap'),
        noCapBody: t('spend.empty.noCap'),
        set: t('spend.caps.setWorkspace'),
        edit: t('spend.caps.editWorkspace'),
        covers: t('spend.caps.appliesTo', { workspace: workspaceName }),
        readOnly: t('spend.caps.instanceOnly'),
        alwaysChip: false,
      }}
      cap={cap}
      canEdit={canEdit}
      onEdit={onEdit}
    />
  );
}

/** The instance cap (BG-1; Admin-Spend board), over every workspace's own. */
export function InstanceCapCard({ cap, onEdit }: { cap: BudgetView | null; onEdit: () => void }) {
  return (
    <CapCard
      copy={{
        title: t('spend.caps.instance'),
        noCap: t('spend.caps.noInstanceCap'),
        noCapBody: t('spend.caps.noInstanceCapBody'),
        set: t('spend.caps.setInstance'),
        edit: t('spend.caps.editInstance'),
        covers: t('spend.caps.instanceCovers'),
        readOnly: '',
        alwaysChip: true,
      }}
      cap={cap}
      canEdit
      onEdit={onEdit}
    />
  );
}

interface CapRow {
  key: string;
  name: ReactNode;
  /** For the button's name: "Edit cap for Lina Berg". */
  plainName: string;
  owner?: string;
  budget: BudgetView | null;
  usedMicroUsd: string;
  /** What limits it when it has no cap of its own. */
  noCapLeft: string;
  canEdit: boolean;
  onEdit: () => void;
}

function capColumns(withOwner: boolean, first: string): Column<CapRow>[] {
  return [
    { key: 'name', header: first, cell: (r) => r.name },
    ...(withOwner
      ? [{ key: 'owner', header: t('spend.caps.col.owner'), cell: (r: CapRow) => r.owner ?? '' }]
      : []),
    {
      key: 'cap',
      header: t('spend.caps.col.cap'),
      numeric: true,
      cell: (r) =>
        r.budget === null ? (
          <span className="text-muted">{t('spend.caps.noCap')}</span>
        ) : (
          formatMicroUsd(r.budget.limitMicroUsd)
        ),
    },
    {
      key: 'resets',
      header: t('spend.caps.col.resets'),
      cell: (r) => (r.budget === null ? t('spend.caps.none') : resetsWord(r.budget.period)),
    },
    {
      key: 'used',
      header: t('spend.caps.col.used'),
      numeric: true,
      cell: (r) => formatMicroUsd(r.usedMicroUsd),
    },
    {
      key: 'left',
      header: t('spend.caps.col.left'),
      numeric: true,
      cell: (r) =>
        r.budget === null ? (
          <span className="font-semibold">{r.noCapLeft}</span>
        ) : (
          <span className="font-semibold">
            {formatMicroUsd(String(reading(r.budget, r.plainName).leftMicro))}
          </span>
        ),
    },
    {
      key: 'state',
      header: t('spend.caps.col.state'),
      cell: (r) => (
        <StateChip state={r.budget === null ? 'none' : reading(r.budget, r.plainName).state} />
      ),
    },
    {
      key: 'actions',
      header: t('spend.caps.col.actions'),
      cell: (r) =>
        r.canEdit ? (
          <Button
            variant="outline"
            aria-label={
              r.budget === null
                ? t('spend.caps.setFor', { name: r.plainName })
                : t('spend.caps.editFor', { name: r.plainName })
            }
            onPress={r.onEdit}
          >
            {r.budget === null ? t('spend.caps.set') : t('spend.caps.edit')}
          </Button>
        ) : null,
    },
  ];
}

/** This month's spend of a person (their keys' included) or of a key, from /budgets. */
function monthSpend(
  budgets: WorkspaceBudgetsView,
  match: { principalId?: string; keyId?: string },
) {
  const row = budgets.monthSpend.find((s) =>
    match.keyId !== undefined
      ? s.keyId === match.keyId
      : s.keyId === null && s.principalId === match.principalId,
  );
  return row?.spentMicroUsd ?? '0';
}

export function MemberCapsTable({
  members,
  budgets,
  onEdit,
}: {
  members: readonly MemberView[];
  budgets: WorkspaceBudgetsView;
  onEdit: (member: MemberView, budget: BudgetView | null) => void;
}) {
  const titleId = useId();
  const rows: CapRow[] = members.map((m) => {
    const budget = budgets.members.find((b) => b.principalId === m.principalId) ?? null;
    return {
      key: m.principalId,
      name: m.displayName,
      plainName: m.displayName,
      budget,
      usedMicroUsd: budget?.spentMicroUsd ?? monthSpend(budgets, { principalId: m.principalId }),
      noCapLeft: t('spend.caps.leftWorkspace'),
      canEdit: true,
      onEdit: () => onEdit(m, budget),
    };
  });
  return (
    <CardSection
      title={t('spend.caps.members')}
      subtitle={t('spend.caps.membersHelp')}
      titleId={titleId}
      flush
    >
      <DataTable
        labelledBy={titleId}
        name={t('spend.caps.members')}
        columns={capColumns(false, t('spend.col.person'))}
        rows={rows}
        rowKey={(r) => r.key}
      />
    </CardSection>
  );
}

export function KeyCapsTable({
  keys,
  budgets,
  onEdit,
}: {
  keys: readonly KeyView[];
  budgets: WorkspaceBudgetsView;
  onEdit: (key: KeyView, budget: BudgetView | null) => void;
}) {
  const titleId = useId();
  const live = keys.filter((k) => k.revokedAt === null);
  const rows: CapRow[] = live.map((k) => {
    const budget = budgets.keys.find((b) => b.keyId === k.id) ?? null;
    return {
      key: k.id,
      name: (
        <TwoLine
          first={k.name}
          second={
            <span className="font-mono">{t('spend.caps.keyPrefix', { prefix: k.prefix })}</span>
          }
        />
      ),
      plainName: k.name,
      owner: k.owner.displayName,
      budget,
      usedMicroUsd: budget?.spentMicroUsd ?? monthSpend(budgets, { keyId: k.id }),
      noCapLeft: t('spend.caps.leftOwner'),
      canEdit: true,
      onEdit: () => onEdit(k, budget),
    };
  });
  return (
    <CardSection
      title={t('spend.caps.keys')}
      subtitle={t('spend.caps.keysHelp')}
      titleId={titleId}
      flush={rows.length > 0}
    >
      {rows.length === 0 ? (
        <p className="text-small text-muted">{t('spend.caps.noKeys')}</p>
      ) : (
        <DataTable
          labelledBy={titleId}
          name={t('spend.caps.keys')}
          columns={capColumns(true, t('spend.caps.col.key'))}
          rows={rows}
          rowKey={(r) => r.key}
        />
      )}
    </CardSection>
  );
}

/** One cap a member counts against, as a card (Spend-Member board). */
function MyCapCard({
  title,
  reading: r,
  smallest,
  detail,
  action,
}: {
  title: string;
  reading: MeterReading | null;
  smallest: boolean;
  detail: string;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <li className="flex">
      <section
        aria-labelledby={id}
        className={`flex w-full min-w-0 flex-col gap-2 lk-card px-4 py-3.5 lg:px-5 lg:py-4 ${r === null ? '' : stateLook[r.state].edge}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={id} className="text-heading">
            {title}
          </h3>
          <span className="flex flex-wrap gap-1.5">
            {smallest && <StatusChip tone="warning">{t('spend.mine.smallest')}</StatusChip>}
            {r !== null && r.state !== 'healthy' && <StateChip state={r.state} />}
            {r === null && <StateChip state="none" />}
          </span>
        </div>
        {r !== null && (
          <>
            <p className={`lk-num text-stat ${stateLook[r.state].text}`}>
              {t('spend.caps.workspaceLeft', { left: formatMicroUsd(String(r.leftMicro)) })}
            </p>
            <CapMeter reading={r} />
          </>
        )}
        <p className="lk-num text-small text-muted">{detail}</p>
        {action}
      </section>
    </li>
  );
}

function usedLine(used: string, limit: string, period: BudgetView['period'], end: string | null) {
  return period === 'none'
    ? t('spend.mine.usedOfNever', { used: formatMicroUsd(used), limit: formatMicroUsd(limit) })
    : `${t('spend.mine.usedOf', {
        used: formatMicroUsd(used),
        limit: formatMicroUsd(limit),
        period: periodWords(period),
      })} ${resetsSentence(end)}`;
}

/**
 * Caps that apply to a member (Spend-Member board): the instance's and the workspace's, which
 * say only what is left and never anyone's spend by person (ADR 0092), their own, and their
 * keys', which they may cap themselves (Q1).
 */
export function MyCaps({
  workspaceName,
  applied,
  smallestScope,
  ownKeys,
  keyBudgets,
  admins,
  onEditKey,
}: {
  workspaceName: string;
  applied: readonly AppliedCapView[];
  smallestScope: AppliedCapView['scope'] | null;
  ownKeys: readonly KeyView[];
  keyBudgets: readonly BudgetView[];
  admins: readonly string[];
  onEditKey: (key: KeyView, budget: BudgetView | null) => void;
}) {
  const id = useId();
  const live = ownKeys.filter((k) => k.revokedAt === null);
  const cards: ReactNode[] = applied.map((cap) => {
    const used = String(BigInt(cap.limitMicroUsd) - BigInt(cap.remainingMicroUsd));
    const name =
      cap.scope === 'member'
        ? t('spend.mine.yours')
        : cap.scope === 'workspace'
          ? t('spend.caps.workspace')
          : t('spend.mine.instance');
    const r = readCap({
      name,
      limitMicro: cap.limitMicroUsd,
      usedMicro: used,
      period: periodWords(cap.period),
      ...(cap.periodEnd === null
        ? {}
        : { resets: t('chat.cap.resets', { date: formatDay(cap.periodEnd) }) }),
      lowAtPercentLeft: cap.lowAtPercentLeft,
    });
    const detail =
      cap.scope === 'member'
        ? `${usedLine(used, cap.limitMicroUsd, cap.period, cap.periodEnd)}${r.state === 'exhausted' ? ` ${t('spend.mine.youRefused')}` : ''}`
        : `${cap.scope === 'workspace' ? t('spend.mine.shared', { workspace: workspaceName }) : t('spend.mine.sharedInstance')} ${resetsSentence(cap.periodEnd)}`;
    return (
      <MyCapCard
        key={cap.scope}
        title={name}
        reading={r}
        smallest={cap.scope === smallestScope}
        detail={detail.trim()}
      />
    );
  });
  for (const k of live) {
    const budget = keyBudgets.find((b) => b.keyId === k.id) ?? null;
    const r = budget === null ? null : reading(budget, t('spend.mine.key', { name: k.name }));
    const detail =
      budget === null
        ? t('spend.mine.keyNoCap')
        : `${usedLine(budget.spentMicroUsd, budget.limitMicroUsd, budget.period, budget.periodEnd)}${r?.state === 'exhausted' ? ` ${t('spend.mine.keyRefused')}` : ''}`;
    cards.push(
      <MyCapCard
        key={k.id}
        title={t('spend.mine.key', { name: k.name })}
        reading={r}
        smallest={false}
        detail={detail}
        action={
          <Button
            variant="outline"
            className="self-start"
            aria-label={
              budget === null
                ? t('spend.caps.setFor', { name: k.name })
                : t('spend.caps.editFor', { name: k.name })
            }
            onPress={() => onEditKey(k, budget)}
          >
            {budget === null ? t('spend.caps.set') : t('spend.caps.edit')}
          </Button>
        }
      />,
    );
  }
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-heading">
          {t('spend.mine.title')}
        </h2>
        <p className="text-small text-muted">
          {admins.length === 0
            ? t('spend.mine.askNobody')
            : t('spend.mine.ask', { names: joinList(admins, 'or') })}
          {live.length > 0 ? ` ${t('spend.mine.ownKeys')}` : ''}
        </p>
      </div>
      {cards.length > 0 && <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards}</ul>}
    </section>
  );
}
