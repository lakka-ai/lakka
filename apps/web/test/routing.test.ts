import { describe, expect, it } from 'vitest';
import type { CentroidSource, ModelView, TryPhraseResult } from '@lakka/contracts';
import { ruleKey } from '../src/components/routing/try-phrase.tsx';
import { t } from '../src/i18n/index.ts';
import {
  appliesDown,
  candidateExampleLine,
  costDirection,
  exampleLines,
  isLongCandidate,
  mostlyKeywords,
  moved,
  parseThreshold,
  percentOf,
  routeStatus,
  scoredFrom,
  withExampleLine,
  withoutExampleLine,
} from '../src/lib/routing.ts';

const model = (id: string, input: number): ModelView =>
  ({
    id,
    displayName: id,
    prices: {
      inputMicroUsdPerMtok: input,
      outputMicroUsdPerMtok: input * 5,
      cacheReadMicroUsdPerMtok: null,
      cacheWriteMicroUsdPerMtok: null,
    },
  }) as unknown as ModelView;

const examples = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);

const models = [model('p:big', 3_000_000), model('p:small', 150_000), model('p:twin', 3_000_000)];

describe('the Routing page (RT-2, RT-5)', () => {
  it('RT-5: compares a route model with the default by blended price, as the resolver does', () => {
    expect(costDirection('p:small', 'p:big', models)).toBe('down');
    expect(costDirection('p:big', 'p:small', models)).toBe('up');
    expect(costDirection('p:big', 'p:big', models)).toBe('same');
    expect(costDirection('p:twin', 'p:big', models)).toBe('same');
    expect(costDirection('p:gone', 'p:big', models)).toBe('unknown');
    expect(costDirection('p:big', null, models)).toBe('unknown');
  });

  it('RT-5: the cheaper direction threshold applies when cheaper, or when prices cannot be compared', () => {
    expect(appliesDown('down')).toBe(true);
    expect(appliesDown('unknown')).toBe(true);
    expect(appliesDown('same')).toBe(false);
    expect(appliesDown('up')).toBe(false);
  });

  it('RT-2: a route with fewer than twelve examples needs more; one switched off is off', () => {
    expect(routeStatus({ enabled: true, examples: examples(7) })).toBe('needsExamples');
    expect(routeStatus({ enabled: true, examples: examples(12) })).toBe('on');
    expect(routeStatus({ enabled: false, examples: examples(12) })).toBe('off');
  });

  it('RT-12: says whether Try a phrase scored a route from its examples or its description', () => {
    const result = {
      scores: [
        { route: 'legal', similarity: 0.61, enabled: true, source: 'description' as const },
        { route: 'code', similarity: 0.32, enabled: true, source: 'examples' as const },
      ],
    };
    expect(scoredFrom(result, 'legal')).toBe('description');
    expect(scoredFrom(result, 'code')).toBe('examples');
    expect(scoredFrom(result, 'writing')).toBeNull();
    expect(scoredFrom(result, null)).toBeNull();
  });

  it('RT-12: says when Try a phrase scored a route from its examples and description', () => {
    const decision = {
      rule: 'classified' as const,
      model: 'p:big',
      route: 'legal',
      signal: null,
      confidence: 0.61,
      reason: null,
      threshold: 0.35,
    };
    const scored = (source: CentroidSource): TryPhraseResult => ({
      status: 'scored',
      scores: [{ route: 'legal', similarity: 0.61, enabled: true, source }],
      closestExamples: [],
      untrained: [],
      decision,
    });
    const label = (source: CentroidSource) => t(ruleKey(decision, scored(source)));
    expect(label('examples')).toBe('Matched examples');
    expect(label('description')).toBe('Matched the description');
    expect(label('examples_and_description')).toBe('Matched examples and the description');
  });

  it('RT-2: examples are the non-empty lines, trimmed', () => {
    expect(exampleLines('  fix this query \n\n why does this return the wrong rows\n  ')).toEqual([
      'fix this query',
      'why does this return the wrong rows',
    ]);
  });

  it('RT-2: warns when most examples are keywords rather than messages', () => {
    const keywords = ['code', 'review', 'git commit', 'typescript'];
    expect(mostlyKeywords(keywords)).toBe(true);
    expect(mostlyKeywords(['How do I undo my last commit?', 'Why does this test fail?'])).toBe(
      false,
    );
    // Half or fewer is not most: a few short lines among real messages are fine.
    expect(mostlyKeywords(['code', 'Why does this function return undefined?'])).toBe(false);
    expect(mostlyKeywords([])).toBe(false);
  });

  it('fallbacks move one place at a time and never off the ends', () => {
    expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('thresholds are numbers from 0 to 1; shares are whole percentages', () => {
    expect(parseThreshold('0.35')).toBe(0.35);
    expect(parseThreshold('1')).toBe(1);
    expect(parseThreshold('.5')).toBe(0.5);
    for (const bad of ['1.5', '-0.1', 'high', '']) expect(parseThreshold(bad)).toBeUndefined();
    expect(percentOf(180, 1420)).toBe(13);
    expect(percentOf(0, 0)).toBe(0);
  });

  it('RT-10, RT-2: a candidate becomes one example line of at most 1000 characters', () => {
    expect(candidateExampleLine('  Summarize this:\n\nthe Q3 report,\tplease  ')).toBe(
      'Summarize this: the Q3 report, please',
    );
    const long = candidateExampleLine(`${'word '.repeat(300)}end`);
    expect(long).toHaveLength(999);
    expect(long.endsWith(' ')).toBe(false);
    expect(exampleLines(long)).toEqual([long]);
    // Never half of a character that takes two code units.
    const emoji = candidateExampleLine(`${'a'.repeat(999)}\u{1F600}`);
    expect(emoji).toBe('a'.repeat(999));
    expect(candidateExampleLine('a'.repeat(1200))).toHaveLength(1000);

    // It goes in as the last line of the box, and comes out again only if still unedited.
    expect(withExampleLine('fix this query\n', 'why is it slow')).toBe(
      'fix this query\nwhy is it slow',
    );
    expect(withExampleLine('  \n', 'why is it slow')).toBe('why is it slow');
    expect(withoutExampleLine('fix this query\nwhy is it slow', 'why is it slow')).toBe(
      'fix this query',
    );
    expect(withoutExampleLine('fix this query\nwhy is it so slow', 'why is it slow')).toBe(
      'fix this query\nwhy is it so slow',
    );
  });

  it('RT-10: a long candidate is clamped, with Show more', () => {
    expect(isLongCandidate('short message')).toBe(false);
    expect(isLongCandidate('x'.repeat(281))).toBe(true);
    expect(isLongCandidate('a\nb\nc\nd\ne')).toBe(true);
  });
});
