import { z } from 'zod';
import { modelRef } from './models.ts';

/*
 * Routing policy (RT-1, RT-2, RT-5, RT-11, ADR 0042). A route links a task label to a model and
 * ordered fallbacks, with example phrasings the classifier learns from and a confidence
 * threshold for each direction: sending work to a cheaper model than the workspace default
 * needs more confidence than sending it to a pricier one (RT-5).
 */

/** Deterministic signals, a fixed published list (E5). Attachment signals arrive with chat. */
export const ROUTING_SIGNALS = ['code_fence', 'code_file'] as const;
export const routingSignal = z.enum(ROUTING_SIGNALS);
export type RoutingSignal = z.infer<typeof routingSignal>;

/**
 * What a route's centroid was made from: its examples; while it has none, its name and
 * description (ADR 0122); or both, the description counting as one example (ADR 0125). RT-12.
 */
export const CENTROID_SOURCES = ['examples', 'description', 'examples_and_description'] as const;
export type CentroidSource = (typeof CENTROID_SOURCES)[number];

/*
 * Which rule chose a request's model (RT-3, RT-8), in the order they are tried: the user's own
 * choice, the conversation's earlier decision, the workspace pin, a deterministic signal, the
 * classifier, and finally the workspace default.
 */
export const RESOLUTION_RULES = [
  'explicit',
  'sticky',
  'pinned',
  'signal',
  'classified',
  'default',
] as const;
export type ResolutionRule = (typeof RESOLUTION_RULES)[number];

/** Why a request fell through to the workspace default (RT-6). */
export const DEFAULT_REASONS = [
  'routing_off',
  'no_routes',
  'too_short',
  'classifier_unavailable',
  'below_threshold',
  'ambiguous',
] as const;
export type DefaultReason = (typeof DEFAULT_REASONS)[number];

export const ROUTE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
/*
 * Tuned on the routing evaluation set (ADR 0045, ADR 0088). The up threshold is mpnet's
 * English-tuned value, and one default serves both bundled models, so a route's thresholds do
 * not depend on which model is loaded (ADR 0123). The tech spec's starting values, 0.75 and
 * 0.55, sit above almost every similarity these models produce and would route almost nothing.
 */
export const DEFAULT_THRESHOLD_DOWN = 0.35;
export const DEFAULT_THRESHOLD_UP = 0.3;
export const MAX_ROUTE_EXAMPLES = 200;
/** Candidates one route save may start from (RT-10, ADR 0114). */
export const MAX_FROM_CANDIDATES = 20;
export const MAX_FALLBACKS = 5;

const threshold = z.number().gt(0).max(1);

/** How many examples the routing page recommends per route (ADR 0045: 12 is enough). */
export const RECOMMENDED_ROUTE_EXAMPLES = 12;

/**
 * Very short messages carry no signal ("make it shorter"); they are not classified at all
 * (tech spec, Performance and caching). The routing page uses the same bound to warn about
 * examples written as keywords, which sit far from any message that does get classified.
 */
export const MIN_CLASSIFY_WORDS = 3;

export function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '').length;
}

export const routeBody = z
  .object({
    name: z.string().regex(ROUTE_NAME_PATTERN),
    description: z.string().trim().max(500).default(''),
    model: modelRef,
    fallbacks: z.array(modelRef).max(MAX_FALLBACKS).default([]),
    allowCrossProvider: z.boolean().default(false),
    thresholdDown: threshold.default(DEFAULT_THRESHOLD_DOWN),
    thresholdUp: threshold.default(DEFAULT_THRESHOLD_UP),
    enabled: z.boolean().default(true),
    signals: z.array(routingSignal).max(ROUTING_SIGNALS.length).default([]),
    /** Example phrasings, one per entry, as an admin typed them (RT-2). */
    examples: z.array(z.string().trim().min(1).max(1000)).max(MAX_ROUTE_EXAMPLES).default([]),
    /**
     * Candidates the admin started examples from (RT-10, ADR 0114), by message id. Saving marks
     * them added, in the same transaction; one that is no longer offered refuses the save.
     */
    fromCandidates: z.array(z.uuid()).max(MAX_FROM_CANDIDATES).optional(),
  })
  .strict()
  .refine((r) => r.thresholdDown >= r.thresholdUp, {
    path: ['thresholdDown'],
    message: 'routing to a cheaper model must need at least as much confidence (RT-5)',
  })
  .refine((r) => new Set(r.signals).size === r.signals.length, {
    path: ['signals'],
    message: 'duplicate',
  })
  .refine(
    (r) => new Set(r.fallbacks).size === r.fallbacks.length && !r.fallbacks.includes(r.model),
    {
      path: ['fallbacks'],
      message: 'fallbacks must be distinct and differ from the model',
    },
  );
export type RouteBody = z.infer<typeof routeBody>;

export const routeParams = z.object({ workspaceId: z.uuid(), routeId: z.uuid() });

export const routingSettingsBody = z
  .object({
    routingEnabled: z.boolean(),
    /** The model used when nothing else decides (RT-6). */
    defaultModel: modelRef.nullable(),
    /** When set, every request in the workspace uses this model unless the user chose one. */
    pinnedModel: modelRef.nullable(),
  })
  .strict();
export type RoutingSettingsBody = z.infer<typeof routingSettingsBody>;

export interface RouteView {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  model: string;
  fallbacks: string[];
  allowCrossProvider: boolean;
  thresholdDown: number;
  thresholdUp: number;
  enabled: boolean;
  signals: RoutingSignal[];
  examples: string[];
  /**
   * When the route was last turned into a centroid, by which embedding model, and from what: its
   * examples, its examples and description (ADR 0125), or, while it has no examples, its
   * description (ADR 0122). RT-12.
   */
  compiled: { at: string; model: string; exampleCount: number; source: CentroidSource } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingSettingsView {
  routingEnabled: boolean;
  defaultModel: string | null;
  pinnedModel: string | null;
  /** Goes up on every change to routes or these settings. */
  policyVersion: number;
}

export interface RoutingPolicyView {
  settings: RoutingSettingsView;
  routes: RouteView[];
}

/** Scores a phrase against the workspace's routes, for admins tuning a policy. */
export const tryPhraseBody = z.object({ text: z.string().trim().min(1).max(4000) }).strict();

/**
 * What the resolution order would do with the phrase as the first message of a new
 * conversation, with no model chosen by the user (RT-3).
 */
export interface TryPhraseDecision {
  rule: ResolutionRule;
  model: string;
  /** The route's name, for a signal or classifier decision. */
  route: string | null;
  signal: RoutingSignal | null;
  confidence: number | null;
  reason: DefaultReason | null;
  /**
   * The lowest confidence the closest route needed (RT-5): its threshold for the direction its
   * model lies from the default. Null when no route was scored.
   */
  threshold: number | null;
}

export interface TryPhraseResult {
  /** scored; too_short (not worth classifying); classifier_unavailable (routing is off for now). */
  status: 'scored' | 'too_short' | 'classifier_unavailable';
  /**
   * Compiled routes, best match first. Routes that are off are scored too, so the tool can say
   * one would have been close, but are never chosen.
   */
  scores: {
    route: string;
    similarity: number;
    enabled: boolean;
    /** What the route was scored against: its examples, its description, or both (RT-12). */
    source: CentroidSource;
  }[];
  /**
   * Up to two of the closest enabled route's examples, nearest the phrase first: why it matched
   * or came close. They are the admin's own policy text, never a request's.
   */
  closestExamples: string[];
  /**
   * Enabled routes with neither examples nor a description to learn from, which the classifier
   * can never choose.
   */
  untrained: string[];
  /** Null when nothing would choose a model: routing found no route and there is no default. */
  decision: TryPhraseDecision | null;
}

/*
 * Overrides per route, for the admin (RT-10, E11, ADR 0048). Counts are requests, not usage
 * rows. Money is integer micro-USD as a decimal string, since it can exceed what a JSON number
 * holds exactly.
 */
export const overridesQuery = z
  .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
  .strict();

export interface RouteOverrideSummary {
  routeId: string;
  /** The route's name, or null if it has been deleted since. */
  route: string | null;
  /** Requests this route decided and the user kept. */
  routedRequests: number;
  /** Requests where the user overrode this route's decision. */
  overrides: number;
  /** Overrides to a model with a higher blended price than the route's, or a lower one. */
  towardsStronger: number;
  towardsCheaper: number;
  /**
   * The model users chose most often instead, and what the route's own requests would have cost
   * on it over the period, minus what they did cost. Null cost when that model has no price.
   */
  suggestion: { model: string; overrides: number; costEffectMicroUsd: string | null } | null;
}

export interface RoutingOverridesView {
  days: number;
  routes: RouteOverrideSummary[];
}

/*
 * Route example candidates (RT-10, ADR 0114): the message a conversation was routed on by the
 * classifier, when the person then chose another model. Derived when read, never stored: offered
 * only while the workspace records content, for a decision whose request was recorded and whose
 * message is still kept. Grouped by the route people moved away from and the model they chose.
 */
export const candidatesQuery = overridesQuery;

export const candidateParams = z.object({ workspaceId: z.uuid(), messageId: z.uuid() });

/** Candidates shown per route and chosen model, newest first. */
export const MAX_CANDIDATES_PER_GROUP = 20;

export interface RouteCandidateView {
  messageId: string;
  /** The message as the person sent it. */
  text: string;
  /** When it was sent. */
  at: string;
  /** When its recorded content expires, and the candidate with it. */
  keptUntil: string;
}

export interface RouteCandidateGroup {
  /** The route people moved away from. */
  routeId: string;
  /** Its name, or null if it has been deleted since. */
  route: string | null;
  /** The model they chose instead. */
  chosenModel: string;
  candidates: RouteCandidateView[];
}

export interface RouteCandidatesView {
  /** Whether the workspace records content now; when it does not, there are no candidates. */
  capture: boolean;
  groups: RouteCandidateGroup[];
}

export type CandidateTarget =
  | { kind: 'route'; routeId: string; name: string }
  | { kind: 'new'; model: string };

/**
 * Where a candidate could go, the suggestion first (RT-10, ADR 0114, D3): routes using the model
 * people chose, then the other routes, then a new route with that model. Never the route they
 * moved away from: an example there would pull more such messages to the model they left.
 */
export function suggestTargetRoute(
  routes: readonly { id: string; name: string; model: string }[],
  chosenModel: string,
  losingRouteId: string,
): CandidateTarget[] {
  const others = routes.filter((r) => r.id !== losingRouteId);
  const first = others.filter((r) => r.model === chosenModel);
  const rest = others.filter((r) => r.model !== chosenModel);
  return [
    ...[...first, ...rest].map((r) => ({ kind: 'route' as const, routeId: r.id, name: r.name })),
    { kind: 'new', model: chosenModel },
  ];
}
