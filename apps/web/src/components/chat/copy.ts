import type {
  AppliedCapView,
  BudgetScope,
  ConversationSummaryView,
  InputSupport,
} from '@lakka/contracts';
import { BUDGET_SCOPES, modelDisplayName, parseModelRef } from '@lakka/contracts';
import { t } from '../../i18n/index.ts';
import type { MessageKey } from '../../i18n/index.ts';
import type { MeterCap } from '../../lib/budget-meter.ts';
import type { ChatErrorDetails } from '../../lib/chat.ts';
import { formatDay } from '../../lib/format.ts';
import { formatCost, formatMicroUsd } from '../../lib/money.ts';
import type { Decision } from '../patterns/why-this-model.tsx';

/*
 * What chat says, worked out from what the api sent (CH-2, CH-4, CH-7). Pure, so each sentence
 * can be tested without rendering.
 */

/** A route's name as people read it: quick-questions -> Quick questions. */
export function routeLabel(name: string): string {
  const words = name.replaceAll('-', ' ');
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

const PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI',
  qwencloud: 'Qwen Cloud',
  'xiaomi-mimo': 'Xiaomi MiMo',
  zai: 'Z.ai',
  mistral: 'Mistral',
  bedrock: 'Amazon Bedrock',
  azure: 'Azure OpenAI',
  groq: 'Groq',
  ollama: 'Ollama',
};

/** A provider's name for people; an OpenAI-compatible endpoint's name as its admin wrote it. */
export function providerLabel(provider: string): string {
  return PROVIDERS[provider] ?? provider;
}

/** A model's name for people when the api did not give one. */
export function modelLabel(ref: string): string {
  return modelDisplayName(parseModelRef(ref)?.model ?? ref);
}

export interface ReplyDecision {
  rule: string | null;
  route: string | null;
  confidence: number | null;
  /**
   * Why the default answered (RT-6). For a sticky reply with no route, the reason the decision
   * it keeps fell to the default, when the thread still shows it.
   */
  reason: string | null;
  fallbackFrom: string | null;
  fallbackFromName?: string | null;
}

/**
 * The reasons that are a considered "not sure" from the classifier (RT-6): the conversation keeps
 * them (RT-7), unlike a message too short to classify or routing being off.
 */
export const NOT_SURE_REASONS: ReadonlySet<string> = new Set(['below_threshold', 'ambiguous']);

const confidenceText = (confidence: number | null) =>
  confidence === null
    ? ''
    : ` ${t('chat.why.confidence', { percent: String(Math.round(confidence * 100)) })}`;

/** Why this model answered, as the chip and its popover say it (Pattern 1, CH-2). */
export function decisionOf(reply: ReplyDecision): Pick<Decision, 'kind' | 'reason' | 'route'> {
  const route = reply.route === null ? undefined : routeLabel(reply.route);
  const withRoute = route === undefined ? {} : { route };
  if (reply.fallbackFrom !== null) {
    const from = reply.fallbackFromName ?? modelLabel(reply.fallbackFrom);
    return { kind: 'fallback', reason: t('chat.why.fallback', { from }), ...withRoute };
  }
  switch (reply.rule) {
    case 'explicit':
      return {
        kind: 'chosen',
        reason:
          route === undefined
            ? t('chat.why.explicitModel')
            : t('chat.why.explicitRoute', { route }),
        ...withRoute,
      };
    case 'pinned':
      return { kind: 'pinned', reason: t('chat.why.pinned') };
    case 'classified':
    case 'signal':
    case 'sticky': {
      if (route === undefined) {
        const notSure = reply.reason !== null && NOT_SURE_REASONS.has(reply.reason);
        return {
          kind: 'default',
          reason: notSure ? t('chat.why.stickyNotSure') : t('chat.why.sticky'),
        };
      }
      const reason =
        reply.rule === 'sticky'
          ? t('chat.why.stickyRoute', { route })
          : reply.rule === 'signal'
            ? t('chat.why.signal', { route })
            : t('chat.why.classified', { route });
      const confidence = reply.rule === 'classified' ? confidenceText(reply.confidence) : '';
      return { kind: 'routed', reason: `${reason}${confidence}`, route };
    }
    default:
      if (reply.reason !== null && NOT_SURE_REASONS.has(reply.reason)) {
        return {
          kind: 'default',
          reason: `${t('chat.why.notSure')}${confidenceText(reply.confidence)}`,
        };
      }
      return { kind: 'default', reason: t('chat.why.default') };
  }
}

const CAP_NAME: Readonly<Record<BudgetScope, MessageKey>> = {
  member: 'chat.cap.member',
  workspace: 'chat.cap.workspace',
  instance: 'chat.cap.instance',
  key: 'chat.cap.key',
};
const CAP_SHORT: Readonly<Record<BudgetScope, MessageKey>> = {
  member: 'chat.cap.short.member',
  workspace: 'chat.cap.short.workspace',
  instance: 'chat.cap.short.instance',
  key: 'chat.cap.short.key',
};
const CAP_IN_SENTENCE: Readonly<Record<BudgetScope, MessageKey>> = {
  member: 'chat.cap.sentence.member',
  workspace: 'chat.cap.sentence.workspace',
  instance: 'chat.cap.sentence.instance',
  key: 'chat.cap.sentence.key',
};
const PERIOD: Readonly<Record<AppliedCapView['period'], MessageKey>> = {
  daily: 'chat.cap.period.daily',
  monthly: 'chat.cap.period.monthly',
  none: 'chat.cap.period.none',
};

/** The caps the api listed, as the budget meter takes them (Pattern 2). */
export function meterCaps(caps: readonly AppliedCapView[]): MeterCap[] {
  return caps.map((cap) => ({
    name: t(CAP_NAME[cap.scope]),
    inSentence: t(CAP_IN_SENTENCE[cap.scope]),
    limitMicro: cap.limitMicroUsd,
    usedMicro: String(BigInt(cap.limitMicroUsd) - BigInt(cap.remainingMicroUsd)),
    period: t(PERIOD[cap.period]),
    ...(cap.periodEnd === null
      ? {}
      : { resets: t('chat.cap.resets', { date: formatDay(cap.periodEnd) }) }),
    lowAtPercentLeft: cap.lowAtPercentLeft,
  }));
}

/** The short line under the header meter: "Workspace, Oct 1". */
export function capShortLine(cap: AppliedCapView): string {
  const name = t(CAP_SHORT[cap.scope]);
  return cap.periodEnd === null ? name : `${name}, ${formatDay(cap.periodEnd)}`;
}

export function capInSentence(scope: BudgetScope): string {
  return t(CAP_IN_SENTENCE[scope]);
}

const capitalized = (text: string) => text.slice(0, 1).toUpperCase() + text.slice(1);
const isScope = (value: string | undefined): value is BudgetScope =>
  value !== undefined && (BUDGET_SCOPES as readonly string[]).includes(value);

/** What a choice reads, for the model picker: "Reads images, PDFs", "Text only". */
export function readsText(input: InputSupport): string {
  if (input.images && input.pdf) return t('chat.reads.both');
  if (input.images) return t('chat.reads.images');
  if (input.pdf) return t('chat.reads.pdf');
  return t('chat.reads.none');
}

export interface ChatProblem {
  title: string;
  body?: string;
  /** Offer to send the message again, and to open the model picker. */
  retry?: boolean;
  pickAnother?: boolean;
}

/**
 * A refusal or failure as one sentence on what happened and one on what to do (CH-7), never a
 * status code. `model` is the model that was answering, for a reply that broke off.
 */
export function problemOf(
  code: string,
  details: ChatErrorDetails,
  context: { caps?: readonly AppliedCapView[]; model?: string } = {},
): ChatProblem {
  switch (code) {
    case 'budget_exceeded': {
      const scope: BudgetScope = isScope(details.scope) ? details.scope : 'member';
      const left = details.remainingMicroUsd;
      if (left === undefined || BigInt(left) === 0n) {
        const cap = context.caps?.find((c) => c.scope === scope);
        return {
          title: t('chat.problem.usedUp.title', { cap: capitalized(capInSentence(scope)) }),
          body:
            cap?.periodEnd === undefined || cap.periodEnd === null
              ? t('chat.problem.usedUp.bodyNever')
              : t('chat.problem.usedUp.body', { date: formatDay(cap.periodEnd) }),
        };
      }
      const required = details.requiredMicroUsd;
      return {
        title: t('chat.problem.notSent'),
        body:
          required === undefined || required === null
            ? t('chat.problem.tooCostly.noEstimate', {
                left: formatMicroUsd(left),
                cap: capInSentence(scope),
              })
            : t('chat.problem.tooCostly', {
                required: formatMicroUsd(required),
                left: formatMicroUsd(left),
                cap: capInSentence(scope),
              }),
        pickAnother: true,
      };
    }
    case 'budget_unavailable':
      return {
        title: t('chat.problem.budgetsDown.title'),
        body: t('chat.problem.budgetsDown.body'),
      };
    // The person's own rate limit (BG-12), or a provider's: the same words, with the wait.
    case 'rate_limited':
      return rateLimited(details);
    case 'upstream_unavailable':
      if (details.rateLimited === true) return rateLimited(details);
      return {
        title:
          details.provider === undefined
            ? t('chat.problem.down.titleUnknown')
            : t('chat.problem.down.title', { provider: providerLabel(details.provider) }),
        body: t('chat.problem.down.body'),
        retry: true,
        pickAnother: true,
      };
    case 'stream_interrupted': {
      const provider = context.model === undefined ? undefined : parseModelRef(context.model);
      return {
        title: t('chat.problem.brokeOff.title'),
        body:
          provider === undefined
            ? t('chat.problem.brokeOff.bodyUnknown')
            : t('chat.problem.brokeOff.body', { provider: providerLabel(provider.provider) }),
        retry: true,
      };
    }
    default:
      return {
        title: t(
          ERROR_KEYS.has(code) ? (`chat.error.${code}` as MessageKey) : 'chat.error.unknown',
        ),
      };
  }
}

function rateLimited(details: ChatErrorDetails): ChatProblem {
  const seconds = details.retryAfterSeconds;
  return {
    title: t('chat.problem.rateLimited.title'),
    body:
      seconds === undefined || seconds === null
        ? t('chat.problem.rateLimited.body')
        : seconds === 1
          ? t('chat.problem.rateLimited.bodyWaitOne')
          : t('chat.problem.rateLimited.bodyWait', { seconds: String(seconds) }),
  };
}

const ERROR_KEYS = new Set<string>([
  'model_not_found',
  'no_model',
  'provider_not_configured',
  'unsupported_input',
  'context_length_exceeded',
  'output_too_long',
  'content_filter',
  'provider_rejected_request',
  'provider_auth_failed',
  'server_shutting_down',
  'request_too_large',
  'invalid_api_key',
  'forbidden',
  'access_revoked',
  'not_found',
  'network',
  'model_choice',
]);

/** "You were charged $0.0031 for it." for a reply stopped part way. */
export function chargedText(costMicroUsd: string | null): string {
  return costMicroUsd === null
    ? ''
    : ` ${t('chat.state.charged', { cost: formatCost(costMicroUsd) })}`;
}

const MONTH = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
const MONTH_YEAR = new Intl.DateTimeFormat('en', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const DAY_MS = 86_400_000;

export interface ConversationGroup {
  label: string;
  conversations: ConversationSummaryView[];
}

/**
 * The conversation list's groups, most recent first (Chat-Desktop board): Today, Previous 7
 * days, then each month, with the year once it is not this one. Days are UTC days, as the server
 * renders them.
 */
export function groupConversations(
  conversations: readonly ConversationSummaryView[],
  now: Date,
): ConversationGroup[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const groups: ConversationGroup[] = [];
  for (const conversation of conversations) {
    const at = new Date(conversation.updatedAt);
    const label =
      at.getTime() >= today
        ? t('chat.group.today')
        : at.getTime() >= today - 7 * DAY_MS
          ? t('chat.group.week')
          : at.getUTCFullYear() === now.getUTCFullYear()
            ? MONTH.format(at)
            : MONTH_YEAR.format(at);
    const last = groups.at(-1);
    if (last?.label === label) last.conversations.push(conversation);
    else groups.push({ label, conversations: [conversation] });
  }
  return groups;
}
