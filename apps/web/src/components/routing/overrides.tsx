import { useId, useRef, useState } from 'react';
import type { Key, ReactNode } from 'react';
import { Button, Dropdown, Label } from '@heroui/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { modelDisplayName, parseModelRef, suggestTargetRoute } from '@lakka/contracts';
import type {
  CandidateTarget,
  ModelView,
  RouteCandidateGroup,
  RouteCandidateView,
  RouteOverrideSummary,
  RouteCandidatesView,
  RoutingOverridesView,
  RoutingPolicyView,
} from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { formatDay } from '../../lib/format.ts';
import { formatMicroUsd } from '../../lib/money.ts';
import { isLongCandidate, percentOf } from '../../lib/routing.ts';
import { formatCount, joinList } from '../../lib/spend.ts';
import { routeLabel } from '../chat/copy.ts';
import { Icon } from '../icons.tsx';
import { CardSection, EmptyList } from '../patterns/card-section.tsx';
import { DataTable } from '../patterns/data-table.tsx';
import { ViewDialog } from '../patterns/form-dialog.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { RouteDialog } from './routes.tsx';

/*
 * When people choose another model (RT-10, ADR 0048; Routing board): per route, how often the
 * routed model answered and how often the person picked another, which way, the model chosen
 * most, and what the route's own requests would have cost on it. Over the api's window, 30 days.
 *
 * While the workspace records content, each route's row can open the messages its conversations
 * were routed on before the person moved away (ADR 0114): grouped by the model they chose, each
 * can be added to a route as an example, never the route they left, or dismissed for good. With
 * capture off, one muted line says how to see them.
 */

function effect(s: RouteOverrideSummary): string {
  if (s.suggestion === null) return '';
  const cost = s.suggestion.costEffectMicroUsd;
  if (cost === null) return t('routing.overrides.unpriced');
  const value = BigInt(cost);
  if (value === 0n) return t('routing.overrides.same');
  const amount = formatMicroUsd(String(value < 0n ? -value : value)).replace(/\.\d\d$/, '');
  return value > 0n
    ? t('routing.overrides.more', { amount })
    : t('routing.overrides.less', { amount });
}

const nameOf = (models: readonly ModelView[], ref: string) =>
  models.find((m) => m.id === ref)?.displayName ??
  modelDisplayName(parseModelRef(ref)?.model ?? ref);

const routeName = (route: string | null) =>
  route === null ? t('routing.overrides.removed') : routeLabel(route);

/** A menu item's key for where a candidate could go. */
const keyOf = (target: CandidateTarget) =>
  target.kind === 'new' ? 'new' : `route:${target.routeId}`;

/** The id of a candidate's text, which its buttons are described by. */
const candidateTextId = (c: RouteCandidateView) => `candidate-${c.messageId}`;

interface Adding {
  target: CandidateTarget;
  candidate: RouteCandidateView;
}

export function Overrides({
  workspaceId,
  view,
  candidates,
  policy,
  models,
}: {
  workspaceId: string;
  view: RoutingOverridesView;
  candidates: RouteCandidatesView;
  policy: RoutingPolicyView;
  models: readonly ModelView[];
}) {
  const titleId = useId();
  const [reviewing, setReviewing] = useState<RouteOverrideSummary | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const days = String(view.days);
  const name = (ref: string) => nameOf(models, ref);
  const groupsOf = (routeId: string) => candidates.groups.filter((g) => g.routeId === routeId);
  const messages = {
    key: 'messages',
    header: t('routing.overrides.messages'),
    cell: (s: RouteOverrideSummary) =>
      groupsOf(s.routeId).length === 0 ? (
        <span className="text-muted">{t('routing.none')}</span>
      ) : (
        <Button
          variant="outline"
          aria-label={t('routing.overrides.reviewFor', { route: routeName(s.route) })}
          onPress={() => setReviewing(s)}
        >
          {t('routing.overrides.review')}
        </Button>
      ),
  };
  const addTo = adding?.target.kind === 'route' ? adding.target.routeId : null;
  const addToRoute = policy.routes.find((r) => r.id === addTo) ?? null;
  return (
    <>
      <CardSection
        title={t('routing.overrides.title')}
        subtitle={t('routing.overrides.subtitle', { days })}
        titleId={titleId}
        flush={view.routes.length > 0}
      >
        {view.routes.length === 0 ? (
          <EmptyList>{t('routing.overrides.empty', { days })}</EmptyList>
        ) : (
          <>
            <DataTable
              labelledBy={titleId}
              name={t('routing.overrides.title')}
              columns={[
                {
                  key: 'route',
                  header: t('routing.col.route'),
                  cell: (s: RouteOverrideSummary) => (
                    <span className="font-semibold">{routeName(s.route)}</span>
                  ),
                },
                {
                  key: 'kept',
                  header: t('routing.overrides.kept'),
                  numeric: true,
                  cell: (s: RouteOverrideSummary) => formatCount(s.routedRequests),
                },
                {
                  key: 'overridden',
                  header: t('routing.overrides.overridden'),
                  numeric: true,
                  cell: (s: RouteOverrideSummary) =>
                    t('routing.overrides.count', {
                      n: formatCount(s.overrides),
                      percent: String(percentOf(s.overrides, s.routedRequests + s.overrides)),
                    }),
                },
                {
                  key: 'direction',
                  header: t('routing.overrides.direction'),
                  numeric: true,
                  cell: (s: RouteOverrideSummary) =>
                    t('routing.overrides.pair', {
                      a: formatCount(s.towardsStronger),
                      b: formatCount(s.towardsCheaper),
                    }),
                },
                {
                  key: 'chosen',
                  header: t('routing.overrides.chosen'),
                  cell: (s: RouteOverrideSummary) =>
                    s.suggestion === null ? '' : name(s.suggestion.model),
                },
                { key: 'effect', header: t('routing.overrides.effect'), cell: effect },
                ...(candidates.capture ? [messages] : []),
              ]}
              rows={view.routes}
              rowKey={(s) => s.routeId}
            />
            <p className="px-5 pb-4 text-small text-muted">{t('routing.overrides.note')}</p>
            {!candidates.capture && (
              <p className="max-w-195 px-5 pb-4 text-small text-muted">
                {t('routing.overrides.captureOff')}
              </p>
            )}
          </>
        )}
      </CardSection>
      {reviewing !== null && (
        <CandidatesDialog
          workspaceId={workspaceId}
          summary={reviewing}
          groups={groupsOf(reviewing.routeId)}
          policy={policy}
          name={name}
          onClose={() => setReviewing(null)}
          onAdd={(candidate, target) => {
            setReviewing(null);
            setAdding({ candidate, target });
          }}
        />
      )}
      {adding !== null && (addToRoute !== null || adding.target.kind === 'new') && (
        <RouteDialog
          workspaceId={workspaceId}
          route={addToRoute}
          policy={policy}
          models={models}
          initialExample={{ messageId: adding.candidate.messageId, text: adding.candidate.text }}
          {...(adding.target.kind === 'new' ? { initialModel: adding.target.model } : {})}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}

/**
 * The messages a route's conversations were routed on, before people chose another model
 * (Pattern 13). Each is plain text, clamped with Show more; its date, the model chosen and how
 * long its recorded text is kept; Add to a route, a menu with the suggestion first; and Dismiss,
 * which is final. A dismissal is said in a status line, and focus moves to the next message.
 */
function CandidatesDialog({
  workspaceId,
  summary,
  groups,
  policy,
  name,
  onClose,
  onAdd,
}: {
  workspaceId: string;
  summary: RouteOverrideSummary;
  groups: readonly RouteCandidateGroup[];
  policy: RoutingPolicyView;
  name: (ref: string) => string;
  onClose: () => void;
  onAdd: (candidate: RouteCandidateView, target: CandidateTarget) => void;
}) {
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const dismiss = useMutation({
    mutationFn: (messageId: string) =>
      api(`/api/workspaces/${workspaceId}/routing/candidates/${messageId}/dismiss`, {
        method: 'POST',
      }),
    onMutate: () => {
      setFailed(false);
      setStatus('');
    },
    onSuccess: async (_result, messageId) => {
      const items = [...(listRef.current?.querySelectorAll('[data-candidate]') ?? [])];
      const at = items.findIndex((el) => el.getAttribute('data-candidate') === messageId);
      await queryClient.invalidateQueries({
        queryKey: ['workspaces', workspaceId, 'routing', 'candidates'],
      });
      setStatus(t('routing.candidates.dismissed'));
      // Focus goes to the message that took its place, or the one before, or Done.
      requestAnimationFrame(() => {
        const left = [...(listRef.current?.querySelectorAll('[data-candidate]') ?? [])];
        const next = left[Math.min(at, left.length - 1)];
        const target =
          next?.querySelector<HTMLElement>('[data-add]') ??
          listRef.current?.closest('[role=dialog]')?.querySelector<HTMLElement>('[data-done]');
        target?.focus();
      });
    },
    onError: () => setFailed(true),
  });
  const routes = policy.routes;
  return (
    <ViewDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('routing.candidates.title', { route: routeName(summary.route) })}
      doneLabel={t('routing.candidates.done')}
    >
      <p className="text-small text-muted">{t('routing.candidates.intro')}</p>
      {failed && <ErrorNotice title={t('routing.candidates.dismissFailed')} />}
      <p role="status" className="sr-only">
        {status}
      </p>
      <div ref={listRef} className="flex flex-col gap-5">
        {groups.length === 0 ? (
          <EmptyList>{t('routing.candidates.empty')}</EmptyList>
        ) : (
          groups.map((group) => (
            <CandidateGroup
              key={group.chosenModel}
              group={group}
              targets={suggestTargetRoute(routes, group.chosenModel, group.routeId)}
              name={name}
              routeModel={(routeId) => routes.find((r) => r.id === routeId)?.model ?? ''}
              onAdd={onAdd}
              onDismiss={(id) => dismiss.mutate(id)}
              dismissing={dismiss.isPending ? (dismiss.variables ?? null) : null}
            />
          ))
        )}
      </div>
    </ViewDialog>
  );
}

function CandidateGroup({
  group,
  targets,
  name,
  routeModel,
  onAdd,
  onDismiss,
  dismissing,
}: {
  group: RouteCandidateGroup;
  targets: readonly CandidateTarget[];
  name: (ref: string) => string;
  routeModel: (routeId: string) => string;
  onAdd: (candidate: RouteCandidateView, target: CandidateTarget) => void;
  onDismiss: (messageId: string) => void;
  dismissing: string | null;
}) {
  const headingId = useId();
  const model = name(group.chosenModel);
  const targetLabel = (target: CandidateTarget) =>
    target.kind === 'new'
      ? t('routing.candidates.newRoute', { model: name(target.model) })
      : t('routing.candidates.toRoute', {
          route: routeLabel(target.name),
          model: name(routeModel(target.routeId)),
        });
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-label font-semibold">
        {t('routing.candidates.group', { model })}
      </h3>
      <ul className="flex flex-col divide-y divide-separator rounded-lg border border-border">
        {group.candidates.map((c) => (
          <Candidate
            key={c.messageId}
            candidate={c}
            meta={t('routing.candidates.meta', {
              date: formatDay(c.at),
              model,
              until: formatDay(c.keptUntil),
            })}
            menu={
              <Dropdown>
                <Button variant="outline" data-add aria-describedby={candidateTextId(c)}>
                  {t('routing.candidates.add')}
                  <Icon name="chevronDown" />
                </Button>
                <Dropdown.Popover placement="bottom start">
                  <Dropdown.Menu
                    aria-label={t('routing.candidates.add')}
                    onAction={(key: Key) => {
                      const target = targets.find((x) => keyOf(x) === key);
                      if (target !== undefined) onAdd(c, target);
                    }}
                  >
                    {targets.map((target) => (
                      <Dropdown.Item
                        key={keyOf(target)}
                        id={keyOf(target)}
                        textValue={targetLabel(target)}
                      >
                        <Label>{targetLabel(target)}</Label>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            }
            isDismissing={dismissing === c.messageId}
            onDismiss={() => onDismiss(c.messageId)}
          />
        ))}
      </ul>
    </section>
  );
}

function Candidate({
  candidate,
  meta,
  menu,
  isDismissing,
  onDismiss,
}: {
  candidate: RouteCandidateView;
  meta: string;
  menu: ReactNode;
  isDismissing: boolean;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const long = isLongCandidate(candidate.text);
  const textId = candidateTextId(candidate);
  return (
    <li data-candidate={candidate.messageId} className="flex flex-col gap-2 px-3.5 py-3">
      {/* Someone else's words, shown as plain text: never markdown, never a link. */}
      <p
        id={textId}
        className={`text-body break-words whitespace-pre-wrap ${long && !open ? 'line-clamp-4' : ''}`}
      >
        {candidate.text}
      </p>
      {long && (
        <Button
          variant="ghost"
          className="lk-link self-start text-caption"
          aria-expanded={open}
          aria-controls={textId}
          onPress={() => setOpen((o) => !o)}
        >
          {open ? t('routing.candidates.showLess') : t('routing.candidates.showMore')}
        </Button>
      )}
      <p className="text-small text-muted">{meta}</p>
      <div className="flex flex-wrap gap-2">
        {menu}
        <Button
          variant="ghost"
          aria-describedby={textId}
          isPending={isDismissing}
          onPress={onDismiss}
        >
          {t('routing.candidates.dismiss')}
        </Button>
      </div>
    </li>
  );
}

/**
 * What a member sees (Routing-States, "Member opens Routing"): a short note, not an error. The
 * api refuses them the policy, so no settings reach the browser.
 */
export function RoutingForMembers({
  workspaceId,
  admins,
}: {
  workspaceId: string;
  admins: readonly string[];
}) {
  return (
    <div className="max-w-xl">
      <CardSection title={t('routing.member.title')}>
        <p>
          {admins.length === 0
            ? t('routing.member.bodyNobody')
            : t('routing.member.body', { names: joinList(admins, 'or') })}
        </p>
        <Link
          to="/workspaces/$workspaceId/chat"
          params={{ workspaceId }}
          className="lk-link lk-link-alone self-start"
        >
          {t('routing.member.back')}
        </Link>
      </CardSection>
    </div>
  );
}
