import pino from 'pino';
import type { DestinationStream, Logger as PinoLogger } from 'pino';
import { LakkaError } from '@lakka/contracts';
import type { LogLevel } from './config.ts';

/*
 * Logging rules (CLAUDE.md invariant 9, NF-S5, ADR 0005): credentials, prompts, responses and
 * tool arguments never reach a log line at any level. This is enforced here, not by convention:
 *
 * - Callers log an event name plus fields. Only field names in LOG_FIELDS survive, and only with
 *   primitive values. Anything else is dropped and counted in `dropped_fields`.
 * - The same filter runs inside pino itself (hooks.logMethod and formatters.bindings), so logs
 *   written by Fastify or any other code holding the raw pino instance are filtered too.
 * - Messages must look like event names (`health.dependency_down`). Free text, including
 *   Fastify's built-in messages that embed error messages, is replaced.
 * - Errors keep their name, a safe code and stack frames. The message is kept only for our own
 *   LakkaError classes, because third-party messages (provider SDKs, drivers) can echo
 *   request content.
 */

/** Field names that may appear in a log line. Add to this list deliberately. */
export const LOG_FIELDS = [
  'service',
  'request_id',
  'reqId',
  'principal_id',
  'workspace_id',
  'method',
  'route',
  'status_code',
  'duration_ms',
  'dependency',
  'status',
  'latency_ms',
  'error_code',
  'host',
  'port',
  'attempt',
  'delay_ms',
  'signal',
  'count',
  'node_version',
  // A budget's scope: instance, workspace, member or key.
  'scope',
  // How far a request's actual cost went past its reservation (budget.overage).
  'overage_micro_usd',
  'dropped_fields',
  // A workspace's content capture period, when the setting changes (NF-P3).
  'retention_days',
  // Who performed an admin action on someone else, such as exporting or deleting them (NF-P4).
  'actor_id',
  // A route example candidate an admin dismissed, by its message's id; never its text (ADR 0114).
  'message_id',
  // How many route example candidates a route save added (ADR 0114).
  'candidates_added',
  // A model catalogue's serial, and what a signed price feed changed (PR-6, ADR 0116).
  'serial',
  'models',
  'prices_changed',
  // A sandbox operation's random id, which its egress token carries; never the token (ADR 0118).
  'operation_id',
  // The uid of a sandbox slot (ADR 0118).
  'slot',
  // How a sandbox runner exited when it failed; never what it wrote (ADR 0118).
  'exit_code',
] as const;

export type LogField = (typeof LOG_FIELDS)[number];
export type LogValue = string | number | boolean | null;
export type LogFields = { readonly [K in LogField]?: LogValue };

export interface Logger {
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields, err?: unknown): void;
  error(event: string, fields?: LogFields, err?: unknown): void;
  fatal(event: string, fields?: LogFields, err?: unknown): void;
  child(bindings: LogFields): Logger;
}

/** The raw pino instance, for frameworks that need one (Fastify's loggerInstance). */
export type FrameworkLogger = PinoLogger;

const ALLOWED = new Set<string>(LOG_FIELDS);
const EVENT_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const MAX_EVENT_LENGTH = 80;
const MAX_STRING_LENGTH = 256;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const REJECTED_EVENT = 'log.message_rejected';

export function safeEvent(value: unknown): string {
  return typeof value === 'string' && value.length <= MAX_EVENT_LENGTH && EVENT_PATTERN.test(value)
    ? value
    : REJECTED_EVENT;
}

export interface SerializedError {
  name: string;
  code?: string;
  message?: string;
  stack?: string;
}

export function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { name: typeof err };
  const out: SerializedError = { name: safeName(err.name) };
  const code: unknown = (err as { code?: unknown }).code;
  if (typeof code === 'string' && SAFE_CODE_PATTERN.test(code)) out.code = code;
  if (err instanceof LakkaError) {
    out.code = err.code;
    out.message = err.message;
  }
  // Keep only frame lines. The first lines of `stack` repeat the message, which may be unsafe.
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
  if (frames !== '') out.stack = frames;
  return out;
}

function safeName(name: string): string {
  return SAFE_CODE_PATTERN.test(name) ? name : 'Error';
}

function safeValue(value: unknown): LogValue | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  return undefined;
}

/** Keeps allowlisted primitive fields and a serialized `err`; drops and counts the rest. */
export function sanitizeFields(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input === null || typeof input !== 'object') return out;
  let dropped = 0;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'err') {
      out['err'] = serializeError(value);
      continue;
    }
    const safe = ALLOWED.has(key) ? safeValue(value) : undefined;
    if (safe === undefined) dropped += 1;
    else out[key] = safe;
  }
  if (dropped > 0) out['dropped_fields'] = dropped;
  return out;
}

/**
 * Normalizes whatever arguments reached pino into `(fields, event)`. Handles every pino call
 * shape: (msg), (obj, msg, ...args), (err), (err, msg). Interpolation args are discarded.
 */
function normalizeArgs(args: unknown[]): [Record<string, unknown>, string] {
  const [first, second] = args;
  if (first instanceof Error) return [sanitizeFields({ err: first }), safeEvent(second)];
  if (first !== null && typeof first === 'object')
    return [sanitizeFields(first), safeEvent(second)];
  return [{}, safeEvent(first)];
}

export interface CreateLoggerOptions {
  level: LogLevel;
  service: string;
  /** Defaults to stdout. Tests pass a capture stream. */
  destination?: DestinationStream;
}

export interface RootLogger {
  logger: Logger;
  frameworkLogger: FrameworkLogger;
}

export function createLogger(options: CreateLoggerOptions): RootLogger {
  const instance = pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Our filter already serialized `err`; stop pino's default serializer from re-expanding it.
      serializers: { err: (value: unknown) => value },
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => sanitizeFields(bindings),
      },
      hooks: {
        logMethod(args, method) {
          const [fields, event] = normalizeArgs(args);
          method.call(this, fields, event);
        },
      },
    },
    options.destination ?? pino.destination({ sync: false }),
  );
  // formatters.bindings only sees the root bindings, not those passed to child(). pino creates
  // each child with Object.create(parent), so this override is inherited by every descendant,
  // including the per-request loggers Fastify creates.
  const protoChild = instance.child;
  instance.child = function child(this: PinoLogger, bindings, childOptions) {
    return protoChild.call(this, sanitizeFields(bindings), childOptions);
  } as typeof instance.child;
  return { logger: wrap(instance), frameworkLogger: instance };
}

function withErr(fields: LogFields | undefined, err: unknown): Record<string, unknown> {
  return err === undefined ? { ...fields } : { ...fields, err };
}

function wrap(p: PinoLogger): Logger {
  return {
    trace: (event, fields) => p.trace({ ...fields }, event),
    debug: (event, fields) => p.debug({ ...fields }, event),
    info: (event, fields) => p.info({ ...fields }, event),
    warn: (event, fields, err) => p.warn(withErr(fields, err), event),
    error: (event, fields, err) => p.error(withErr(fields, err), event),
    fatal: (event, fields, err) => p.fatal(withErr(fields, err), event),
    child: (bindings) => wrap(p.child({ ...bindings })),
  };
}
