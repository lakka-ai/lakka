import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Input, Label, TextField } from '@heroui/react';
import { useMutation } from '@tanstack/react-query';
import type { ModelView, TryPhraseResult } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { api } from '../../lib/api.ts';
import { scoredFrom } from '../../lib/routing.ts';
import { joinList } from '../../lib/spend.ts';
import { routeLabel } from '../chat/copy.ts';
import { CardSection } from '../patterns/card-section.tsx';
import { ErrorNotice } from '../patterns/notices.tsx';
import { Icon } from '../icons.tsx';

/*
 * Try a phrase (RT-2, RT-3, RT-5; Routing board, Try a phrase; Routing-States, "no route is
 * sure enough"). What the resolution order would do with the phrase as a new conversation's
 * first message: the route or the default, why, how sure, the runner-up or the closest route
 * and what it needed, and the examples it was closest to, or its description when it has none
 * (RT-12, ADR 0122). A match says whether the route was scored from its examples, its
 * description, or both (ADR 0125). Nothing is sent to a model, charged, stored or logged. The
 * result is a status region, announced after Try.
 */

const two = (n: number) => n.toFixed(2);

/** The Rule row's text for a decision. */
export function ruleKey(
  decision: NonNullable<TryPhraseResult['decision']>,
  result: TryPhraseResult,
): MessageKey {
  switch (decision.rule) {
    case 'classified':
      switch (scoredFrom(result, decision.route)) {
        case 'description':
          return 'routing.try.rule.classifiedDescription';
        case 'examples_and_description':
          return 'routing.try.rule.classifiedBoth';
        default:
          return 'routing.try.rule.classified';
      }
    case 'pinned':
      return 'routing.try.rule.pinned';
    default:
      switch (decision.reason) {
        case 'below_threshold':
          return 'routing.try.rule.below_threshold';
        case 'ambiguous':
          return 'routing.try.rule.ambiguous';
        case 'too_short':
          return 'routing.try.rule.too_short';
        case 'classifier_unavailable':
          return 'routing.try.rule.classifier_unavailable';
        case 'routing_off':
          return 'routing.try.rule.routing_off';
        default:
          return 'routing.try.rule.no_routes';
      }
  }
}

function Result({ result, models }: { result: TryPhraseResult; models: readonly ModelView[] }) {
  const { decision } = result;
  if (decision === null) return <p className="font-semibold">{t('routing.try.nothing')}</p>;
  const model = models.find((m) => m.id === decision.model)?.displayName ?? decision.model;
  const routed = decision.rule === 'classified' || decision.rule === 'signal';
  const title =
    routed && decision.route !== null
      ? t('routing.try.route', { route: routeLabel(decision.route), model })
      : decision.rule === 'pinned'
        ? t('routing.try.pinned', { model })
        : t('routing.try.default', { model });
  const rows: [string, string][] = [
    [
      t('routing.try.rule'),
      decision.rule === 'signal' && decision.signal !== null
        ? t('routing.try.rule.signal', { signal: t(`routing.signal.${decision.signal}`) })
        : t(ruleKey(decision, result)),
    ],
  ];
  const [best] = result.scores.filter((s) => s.enabled);
  if (decision.rule === 'classified' && decision.confidence !== null) {
    rows.push([
      t('routing.try.confidence'),
      decision.threshold === null
        ? two(decision.confidence)
        : t('routing.try.above', {
            confidence: two(decision.confidence),
            threshold: two(decision.threshold),
          }),
    ]);
    const runnerUp = result.scores.find((s) => s.route !== decision.route);
    if (runnerUp !== undefined) {
      const params = { route: routeLabel(runnerUp.route), confidence: two(runnerUp.similarity) };
      rows.push([
        t('routing.try.runnerUp'),
        runnerUp.enabled ? t('routing.try.score', params) : t('routing.try.skipped', params),
      ]);
    }
  } else if (decision.rule === 'default' && best !== undefined && result.status === 'scored') {
    const params = { route: routeLabel(best.route), confidence: two(best.similarity) };
    rows.push([
      t('routing.try.closest'),
      decision.threshold === null
        ? t('routing.try.score', params)
        : t('routing.try.needs', { ...params, threshold: two(decision.threshold) }),
    ]);
  }
  // The route the reason is about: the one chosen, or the closest one that was not sure enough.
  const reasonRoute =
    decision.rule === 'classified'
      ? decision.route
      : decision.rule === 'default'
        ? best?.route
        : null;
  if (
    result.closestExamples.length > 0 &&
    (decision.rule === 'classified' || decision.rule === 'default')
  ) {
    rows.push([
      t('routing.try.reason'),
      t('routing.try.examples', {
        list: joinList(result.closestExamples.map((e) => `"${e}"`)),
      }),
    ]);
  } else if (
    result.status === 'scored' &&
    reasonRoute !== undefined &&
    scoredFrom(result, reasonRoute) === 'description'
  ) {
    rows.push([t('routing.try.reason'), t('routing.try.description')]);
  }
  if (result.untrained.length > 0) {
    rows.push([
      '',
      t('routing.try.untrained', { routes: joinList(result.untrained.map(routeLabel)) }),
    ]);
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-note bg-surface-secondary px-4 py-3.5">
      <p className="font-semibold">{title}</p>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body">
        {rows.map(([term, detail]) => (
          <div key={`${term}${detail}`} className="contents">
            <dt className="text-small text-muted">{term}</dt>
            <dd>{detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function TryPhrase({
  workspaceId,
  models,
}: {
  workspaceId: string;
  models: readonly ModelView[];
}) {
  const titleId = useId();
  const [text, setText] = useState('');
  const run = useMutation({
    mutationFn: (phrase: string) =>
      api<TryPhraseResult>(`/api/workspaces/${workspaceId}/routing/try`, {
        method: 'POST',
        body: { text: phrase },
      }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text.trim() !== '') run.mutate(text);
  }

  return (
    <CardSection
      title={t('routing.try.title')}
      subtitle={t('routing.try.subtitle')}
      titleId={titleId}
    >
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <TextField value={text} onChange={setText} className="min-w-0 grow">
          <Label>{t('routing.try.message')}</Label>
          <Input maxLength={4000} />
        </TextField>
        <Button size="lg" type="submit" variant="tertiary" isPending={run.isPending}>
          <Icon name="play" />
          {t('routing.try.submit')}
        </Button>
      </form>
      <div role="status">
        {run.isError && <ErrorNotice title={t('routing.try.failed')} />}
        {run.data !== undefined && <Result result={run.data} models={models} />}
      </div>
    </CardSection>
  );
}
