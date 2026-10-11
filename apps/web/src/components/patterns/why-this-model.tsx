import { Button, chipVariants, Popover } from '@heroui/react';
import { Link } from '@tanstack/react-router';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';

/*
 * Pattern 1, Why this model (CH-2). A chip next to the model name on every reply, opening a
 * popover with the reason, the model, the route, the cost and a link to the trace. The chip's
 * text stays short so it survives translation; its accessible name is the whole reason.
 */

export type DecisionKind = 'routed' | 'chosen' | 'default' | 'pinned' | 'fallback' | 'refused';

export interface Decision {
  kind: DecisionKind;
  /** The full sentence: "Routing matched the message to the Code route. Confidence 92%." */
  reason: string;
  /** The model id as the provider knows it: anthropic:claude-sonnet-4-5. */
  modelId?: string;
  /** The route's name, when a route chose the model. */
  route?: string;
  /** Formatted: "$0.0094". */
  cost?: string;
  trace?: { workspaceId: string; requestId: string };
}

const look: Record<DecisionKind, { icon: IconName; chip: string }> = {
  routed: {
    icon: 'routing',
    chip: 'bg-lk-routed-soft text-lk-routed',
  },
  chosen: {
    icon: 'person',
    chip: 'bg-lk-chosen-soft text-lk-chosen',
  },
  default: {
    icon: 'target',
    chip: 'bg-lk-default-soft text-lk-default',
  },
  // The theme has no pinned pair; the board draws it like the default.
  pinned: {
    icon: 'pin',
    chip: 'bg-lk-default-soft text-lk-default',
  },
  fallback: {
    icon: 'cheaper',
    chip: 'bg-lk-fallback-soft text-lk-fallback',
  },
  refused: {
    icon: 'ban',
    chip: 'bg-lk-refused-soft text-lk-refused',
  },
};

const chipText: Record<Exclude<DecisionKind, 'routed'>, MessageKey> = {
  chosen: 'why.chip.chosen',
  default: 'why.chip.default',
  pinned: 'why.chip.pinned',
  fallback: 'why.chip.fallback',
  refused: 'why.chip.refused',
};

export function decisionChipText(decision: Pick<Decision, 'kind' | 'route'>): string {
  return decision.kind === 'routed'
    ? t('why.chip.routed', { route: decision.route ?? '' })
    : t(chipText[decision.kind]);
}

// HeroUI's md chip classes: the decision chip is one, a button where it opens the popover.
const chipBase = chipVariants({ size: 'md' }).base();

/** The chip alone, for a place that explains the decision some other way. */
export function DecisionChip({ decision }: { decision: Pick<Decision, 'kind' | 'route'> }) {
  return (
    <span className={`${chipBase} ${look[decision.kind].chip}`}>
      <Icon name={look[decision.kind].icon} className="size-3.5" />
      {decisionChipText(decision)}
    </span>
  );
}

export function WhyThisModel({
  decision,
  defaultOpen = false,
}: {
  decision: Decision;
  /** Opens the popover on first render, for stories and tests. */
  defaultOpen?: boolean;
}) {
  const rows: [MessageKey, string, boolean][] = [];
  if (decision.modelId !== undefined) rows.push(['why.model', decision.modelId, true]);
  if (decision.route !== undefined) rows.push(['why.route', decision.route, false]);
  if (decision.cost !== undefined) rows.push(['why.cost', decision.cost, false]);

  return (
    <Popover defaultOpen={defaultOpen}>
      <Button
        variant="ghost"
        aria-label={t('why.button', { reason: decision.reason })}
        className={`${chipBase} ${look[decision.kind].chip} min-w-0 hover:opacity-90`}
      >
        <Icon name={look[decision.kind].icon} className="size-3.5" />
        {decisionChipText(decision)}
        <Icon name="chevronDown" className="size-3" />
      </Button>
      <Popover.Content placement="bottom start" className="lk-popover-fit w-104">
        <Popover.Dialog className="flex flex-col gap-3 p-4">
          <Popover.Heading className="text-small font-medium">{t('why.title')}</Popover.Heading>
          <p className="text-body">{decision.reason}</p>
          {rows.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
              {rows.map(([term, value, mono]) => (
                <div key={term} className="contents">
                  <dt className="text-muted">{t(term)}</dt>
                  <dd className={mono ? 'font-mono' : 'lk-num'}>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {decision.trace !== undefined && (
            <Link
              to="/workspaces/$workspaceId/requests/$requestId"
              params={decision.trace}
              className="lk-link lk-link-alone self-start text-small"
            >
              {t('why.viewTrace')}
            </Link>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
