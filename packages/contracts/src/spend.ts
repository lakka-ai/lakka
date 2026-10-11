import { z } from 'zod';
import type { BudgetView } from './budgets.ts';

/*
 * The spend view (BG-11, F5, ADR 0055): what was spent, by person, by workspace, by model and by
 * day, for a buyer who is not an engineer. Figures come from usage records, so they match what
 * budgets were charged. Money is integer micro-USD as a decimal string.
 */

const isoDate = z.iso.date();

/** A range of whole UTC days, both ends included. Defaults to the current month so far. */
export const spendQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();
export type SpendQuery = z.infer<typeof spendQuery>;

/** The longest range one report covers. */
export const MAX_SPEND_DAYS = 366;

export interface SpendRow {
  /** A workspace id, the person's principal id, or a model reference. */
  key: string;
  label: string;
  costMicroUsd: string;
  requests: number;
}

/** A workspace, with its own cap if it has one, as of now (ADR 0097). */
export interface SpendWorkspaceRow extends SpendRow {
  cap: BudgetView | null;
  /** A deleted workspace's spend stays in the instance's records (ID-8, ADR 0104). */
  deleted: boolean;
}

/**
 * Who sent the requests (ADR 0093): a person's own requests, or one of their keys' on a row of
 * its own, so every dollar is counted once. A person's cap still counts their keys' spend.
 */
export interface SpendPrincipalRow extends SpendRow {
  kind: 'user' | 'key';
  /** For a key, the person it acts for. */
  owner: { id: string; name: string } | null;
}

/**
 * How the model was picked: by a route (its conversation's earlier decision and a signal
 * included), the workspace default when no route was sure enough, the person's own choice
 * (overrides of a route included), or the workspace's pinned model.
 */
export type SpendRouteKind = 'route' | 'default' | 'chosen' | 'pinned';

export interface SpendRouteRow extends SpendRow {
  kind: SpendRouteKind;
  /** For a route: the model it sends to now, and that model's name. */
  model: string | null;
  modelName: string | null;
}

/** Why requests were refused before anything was charged, from their traces. */
export const REFUSAL_CODES = [
  'budget_exceeded',
  'budget_unavailable',
  'rate_limited',
  'forbidden',
  'no_model',
  'unsupported_input',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** A median and a 95th percentile. */
export interface Spread {
  p50: number;
  p95: number;
}

/** How fast and how large one model's completed replies were. */
export interface ModelSpeedRow {
  model: string;
  name: string;
  requests: number;
  /** Milliseconds from sending to the last token. */
  latency: Spread;
  /** Milliseconds to the first token; null when no reply streamed. */
  timeToFirstToken: Spread | null;
  inputTokens: Spread;
  outputTokens: Spread;
}

export interface SpendReport {
  /** Whose spend this is: the whole instance, one workspace, or the caller's own. */
  scope: 'instance' | 'workspace' | 'own';
  from: string;
  to: string;
  totalMicroUsd: string;
  requests: number;
  /** Requests a cap sent to a cheaper model than the one chosen (BG-7). */
  downgradedRequests: number;
  /** What those requests cost on the cheaper model. */
  downgradedMicroUsd: string;
  byWorkspace: SpendWorkspaceRow[];
  byPerson: SpendPrincipalRow[];
  /** By model reference; the label is the model's name for people. */
  byModel: SpendRow[];
  /** Every day in the range, including days with no spend. */
  byDay: { date: string; costMicroUsd: string; requests: number }[];
  /** Chat, the API or MCP. */
  bySurface: SpendRow[];
  /**
   * By how the model was picked: each route under its id, and the default, the person's choice
   * and the pinned model under their kind.
   */
  byRoute: SpendRouteRow[];
  /** Over completed attempts, in milliseconds; null with none. */
  latency: { p50: number; p95: number } | null;
  /** The spread of token counts, not the average (the tech spec's metrics from day one). */
  tokens: { inputP50: number; inputP95: number; inputMax: number; outputP95: number } | null;
  /** Requests a cap refused outright. */
  deniedRequests: number;
  /**
   * Requests refused before anything was charged, by why, most first. Read from traces, so only
   * as far back as traces are kept (OB-6).
   */
  refusals: { code: RefusalCode; requests: number }[];
  /** Tool calls by tool: how many, how many failed, how many were refused (TL-6). */
  tools: { name: string; calls: number; failed: number; refused: number }[];
  /** Tool calls that ran, whatever their result. */
  toolCallsRan: number;
  /** Tool calls the person was not allowed to make, or had no credential for (TL-5). */
  toolCallsNotAllowed: number;
  /** Tool calls the person was asked about and denied (TL-4). */
  toolCallsDenied: number;
  /** By model, most requests first. */
  speedByModel: ModelSpeedRow[];
}
