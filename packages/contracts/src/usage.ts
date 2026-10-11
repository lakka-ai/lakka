/*
 * Usage records (BG-8, tech spec Data model: Cost; ADR 0039). One row per provider attempt that
 * may have cost money, attributed to a principal, a workspace, a surface and a model, with the
 * prices it was charged at.
 */

/** Where a request came from (tech spec: surfaces). */
export const SURFACES = ['chat', 'api', 'mcp'] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * How an attempt ended:
 * - completed: the provider finished and reported usage
 * - interrupted: it failed after the first chunk reached the client
 * - aborted: the client went away or the server shut down mid-stream
 * - abandoned: it was given up inside the commitment window and retried or failed over;
 *   the provider may still bill the prompt
 */
export const USAGE_OUTCOMES = ['completed', 'interrupted', 'aborted', 'abandoned'] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];
