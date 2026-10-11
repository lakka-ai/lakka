import {
  blendedPrice,
  MIN_CLASSIFY_WORDS,
  RECOMMENDED_ROUTE_EXAMPLES,
  wordCount,
} from '@lakka/contracts';
import type { CentroidSource, ModelView, RouteView, TryPhraseResult } from '@lakka/contracts';

/*
 * What the Routing page works out from the policy (RT-1, RT-2, RT-5; Routing board): how a
 * route's model compares with the default, which of its two thresholds applies, whether it has
 * enough examples, and the fallback list's moves. The api decides; these only describe.
 */

export type CostDirection = 'same' | 'down' | 'up' | 'unknown';

/**
 * How a model's price compares with the default's, by the blended price the resolver uses
 * (RT-5). The default itself, or a model priced the same, is "same".
 */
export function costDirection(
  model: string,
  defaultModel: string | null,
  models: readonly ModelView[],
): CostDirection {
  if (defaultModel !== null && model === defaultModel) return 'same';
  const price = (ref: string | null) => models.find((m) => m.id === ref)?.prices;
  const target = price(model);
  const fallback = price(defaultModel);
  if (target === undefined || fallback === undefined) return 'unknown';
  const a = blendedPrice(target);
  const b = blendedPrice(fallback);
  return a < b ? 'down' : a > b ? 'up' : 'same';
}

/**
 * Which threshold routing compares against (RT-5): the cheaper direction's, which is the higher,
 * for a model cheaper than the default, or when the two cannot be compared, as the resolver does.
 */
export const appliesDown = (direction: CostDirection) =>
  direction === 'down' || direction === 'unknown';

export type RouteStatus = 'on' | 'needsExamples' | 'off';

/** Off, on with fewer than the twelve examples ADR 0045 recommends, or on. */
export function routeStatus(route: Pick<RouteView, 'enabled' | 'examples'>): RouteStatus {
  if (!route.enabled) return 'off';
  return route.examples.length < RECOMMENDED_ROUTE_EXAMPLES ? 'needsExamples' : 'on';
}

/**
 * What Try a phrase scored a route from: its examples, or, while it has none, its description
 * (RT-12, ADR 0122). Null for a route it did not score.
 */
export function scoredFrom(
  result: Pick<TryPhraseResult, 'scores'>,
  route: string | null,
): CentroidSource | null {
  return result.scores.find((s) => s.route === route)?.source ?? null;
}

/** The example phrasings in the box: one per non-empty line, trimmed. */
export function exampleLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Whether most example lines are keywords rather than messages (RT-2). Routing compares a
 * message's meaning with the examples', and a line of one or two words sits far from any message
 * long enough to be classified, so keyword examples route almost nothing.
 */
export function mostlyKeywords(lines: readonly string[]): boolean {
  const short = lines.filter((line) => wordCount(line) < MIN_CLASSIFY_WORDS).length;
  return short * 2 > lines.length;
}

/** The list with the item at `index` moved one place up (-1) or down (1). */
export function moved<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  // The index was checked to be in range above.
  next.splice(to, 0, item as T);
  return next;
}

/** The longest example the api takes (RT-2): one line of at most this many characters. */
export const MAX_EXAMPLE_LENGTH = 1000;

/**
 * A route example candidate as one example line (RT-10, RT-2, ADR 0114): newlines and runs of
 * spaces collapsed, trimmed, and cut to the longest example the api takes, never inside a
 * character that takes two code units.
 */
export function candidateExampleLine(text: string): string {
  let line = text.replace(/\s+/g, ' ').trim().slice(0, MAX_EXAMPLE_LENGTH).trimEnd();
  if (/[\uD800-\uDBFF]$/.test(line)) line = line.slice(0, -1);
  return line;
}

/** The examples box with `line` added as its last line. */
export function withExampleLine(examples: string, line: string): string {
  const before = examples.trimEnd();
  return before === '' ? line : `${before}\n${line}`;
}

/** The examples box without its last line, if that line is still `line`. */
export function withoutExampleLine(examples: string, line: string): string {
  const lines = examples.trimEnd().split('\n');
  if (lines.at(-1)?.trim() !== line) return examples;
  return lines.slice(0, -1).join('\n');
}

/** Whether a candidate's text is long enough to clamp, with Show more to read the rest. */
export function isLongCandidate(text: string): boolean {
  return text.length > 280 || text.split('\n').length > 4;
}

/** A threshold as the field takes it: a number from 0 to 1. */
export function parseThreshold(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^(0(\.\d{1,4})?|1(\.0{1,4})?|\.\d{1,4})$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** A share as a whole percentage: 180 of 1,420 -> 13. */
export function percentOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part * 100) / whole);
}
