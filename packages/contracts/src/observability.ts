import { z } from 'zod';

/*
 * Content capture (OB-4, NF-P3, ADR 0077): off by default. A workspace admin may turn it on, and
 * choose how long recorded prompts and replies are kept. Who changed it, and when, is shown
 * with the setting.
 */

export const CONTENT_RETENTION_DAYS = { min: 1, max: 90, default: 7 } as const;

export const contentCaptureBody = z
  .object({
    enabled: z.boolean(),
    retentionDays: z.int().min(CONTENT_RETENTION_DAYS.min).max(CONTENT_RETENTION_DAYS.max),
  })
  .strict();
export type ContentCaptureBody = z.infer<typeof contentCaptureBody>;

export interface ContentCaptureView {
  enabled: boolean;
  retentionDays: number;
  changedAt: string | null;
  changedBy: { id: string; displayName: string } | null;
}

/*
 * Retention (OB-6, NF-P5, ADR 0078): how long each kind of record is kept, for the whole instance.
 * Captured content keeps each workspace's own period. Conversations are kept until deleted unless
 * a period is set (null).
 */
export const RETENTION_LIMITS = {
  spansDays: { min: 1, max: 365, default: 30 },
  usageMonths: { min: 2, max: 120, default: 13 },
  conversationsDays: { min: 1, max: 3650, default: null },
  toolAuditDays: { min: 1, max: 3650, default: 90 },
  budgetAlertsMonths: { min: 1, max: 120, default: 13 },
  reservationsDays: { min: 1, max: 365, default: 30 },
} as const;

const within = (limits: { min: number; max: number }) => z.int().min(limits.min).max(limits.max);

export const retentionBody = z
  .object({
    spansDays: within(RETENTION_LIMITS.spansDays),
    usageMonths: within(RETENTION_LIMITS.usageMonths),
    conversationsDays: within(RETENTION_LIMITS.conversationsDays).nullable(),
    toolAuditDays: within(RETENTION_LIMITS.toolAuditDays),
    budgetAlertsMonths: within(RETENTION_LIMITS.budgetAlertsMonths),
    reservationsDays: within(RETENTION_LIMITS.reservationsDays),
  })
  .strict();
export type RetentionBody = z.infer<typeof retentionBody>;

/** Whether traces also leave the instance, and to where: the endpoint's origin only (ADR 0080). */
export interface TraceExportView {
  enabled: boolean;
  destination: string | null;
}

/** What one enforcement removed, by kind of record. */
export interface RetentionDeleted {
  spans: number;
  spanContent: number;
  usage: number;
  conversations: number;
  toolRecords: number;
  budgetAlerts: number;
  reservations: number;
  oauthStates: number;
  passwordResets: number;
}

/** A run's counts as kept; null for a kind the run did not count yet (a run from an older version). */
export type RetentionRunCounts = { [K in keyof RetentionDeleted]: number | null };

export interface RetentionView extends RetentionBody {
  updatedAt: string | null;
  updatedBy: string | null;
  /** durationMs is null for a run recorded before it was kept. */
  lastRun: { at: string; durationMs: number | null; deleted: RetentionRunCounts } | null;
}

/*
 * Traces (OB-1, ADR 0079): the requests of a workspace, newest first, and one request's spans,
 * attempts and, where the workspace recorded it, what was said. Workspace admins see every request
 * in their workspace; members see their own, made directly or through their keys.
 */

/**
 * What became of a request, as the list shows and filters it (ADR 0095): answered, answered by a
 * cheaper model because a cap had no room (BG-7), refused before anything was charged, stopped by
 * the person, or failed after it was sent.
 */
export const REQUEST_OUTCOMES = ['completed', 'cheaper', 'refused', 'stopped', 'failed'] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

const listDay = z.iso.date();

export const requestListQuery = z
  .object({
    /**
     * The next page: the cursor the previous page gave. Opaque; it orders requests that
     * started at the same moment too, so none is skipped.
     */
    before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f]{16}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** Only this person's requests, theirs and their keys'. Admins only. */
    person: z.uuid().optional(),
    surface: z.enum(['chat', 'api', 'mcp']).optional(),
    outcome: z.enum(REQUEST_OUTCOMES).optional(),
    /** Whole UTC days, both ends included. */
    from: listDay.optional(),
    to: listDay.optional(),
  })
  .strict();
export type RequestListQuery = z.infer<typeof requestListQuery>;

export const requestParams = z.object({ workspaceId: z.uuid(), requestId: z.uuid() });

export interface RequestSummaryView {
  requestId: string;
  traceId: string;
  startedAt: string;
  durationMs: number;
  /** Error when the request was refused or failed; its error type says why. */
  status: 'ok' | 'error';
  errorType: string | null;
  surface: string | null;
  model: string | null;
  outcome: string | null;
  /** Who made it: a person, or one of their keys. */
  principal: { id: string; name: string; kind: 'user' | 'key' } | null;
  /** The person behind it. */
  person: { id: string; name: string } | null;
  conversationId: string | null;
  /** Over every attempt, from usage records, the requests that continued it included. */
  costMicroUsd: string;
  outcomeKind: RequestOutcome;
  /** How the model was picked (RT-8), for "Code route, 0.91" or "Chosen by the person". */
  decision: {
    /** What was asked for: 'auto', a model reference, or 'route/<name>'. */
    requested: string | null;
    rule: string | null;
    route: { id: string; name: string | null } | null;
    confidence: number | null;
    threshold: number | null;
    reason: string | null;
  };
  /** A cap that refused the request or sent it to a cheaper model (BG-7). */
  budget: {
    scope: 'instance' | 'workspace' | 'member' | 'key';
    remainingMicroUsd: string | null;
    /** For a cheaper model: the model chosen first, and the one that answered. */
    from: string | null;
    to: string | null;
  } | null;
  /** The provider that did not answer, for a request that failed. */
  provider: string | null;
  /** A tool call in it was denied by the person (TL-4). */
  toolDenied: boolean;
}

export interface RequestListView {
  requests: RequestSummaryView[];
  /** Pass as `before` for the next page; null when there are no more. */
  nextBefore: string | null;
  /** How many requests match, over every page. */
  total: number;
}

export interface SpanView {
  spanId: string;
  /** The request it belongs to: the first, or one that continued it after an approval. */
  requestId: string | null;
  parentSpanId: string | null;
  depth: number;
  name: string;
  kind: string;
  status: 'unset' | 'ok' | 'error';
  errorType: string | null;
  /** From the start of the request. */
  offsetMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  events: { name: string; atMs: number; attributes: Record<string, unknown> }[];
}

export interface AttemptView {
  /** The request it belongs to: the first, or one that continued it after an approval. */
  requestId: string;
  attempt: number;
  model: string;
  provider: string;
  outcome: string;
  /** Why the model stopped: 'stop', 'tool-calls', 'length', and so on. */
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: string;
  latencyMs: number;
  ttftMs: number | null;
}

export interface CapturedContentView {
  spanId: string;
  prompt: unknown;
  response: unknown;
  expiresAt: string;
}

/**
 * A tool call that waited for a person (TL-4): when it asked, and when and how it was answered.
 * Offsets are from the start of the first request.
 */
export interface ApprovalWaitView {
  approvalId: string;
  toolName: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  always: boolean;
  askedOffsetMs: number;
  answeredOffsetMs: number | null;
  answeredBy: { id: string; name: string } | null;
}

export interface TraceView {
  /** The first request, with the chain's cost and time. */
  request: RequestSummaryView;
  /**
   * Every span of the request and of those that continued it after an approval, as one tree
   * under the first request, with offsets from its start (ADR 0095).
   */
  spans: SpanView[];
  attempts: AttemptView[];
  approvals: ApprovalWaitView[];
  /** Present only where the workspace recorded prompts and replies (ADR 0077). */
  content: CapturedContentView[];
  /** Names of the routes the spans name by id; a removed route is missing. */
  routes: { id: string; name: string }[];
}
