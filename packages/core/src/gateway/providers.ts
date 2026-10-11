import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { ConfigError } from '@lakka/contracts';
import type { ProviderKind } from '@lakka/contracts';

/*
 * Builds AI SDK language models for one provider connection (ADR 0036). Everything the SDK
 * would otherwise read from environment variables (API keys, base URLs) is passed explicitly,
 * so a stray OPENAI_BASE_URL or ANTHROPIC_API_KEY in the container can never redirect traffic
 * or bill the wrong account. Keys come only from stored, encrypted provider credentials.
 */

/** Where each first-party provider lives unless a credential says otherwise. */
export const DEFAULT_BASE_URLS: Readonly<
  Record<Exclude<ProviderKind, 'openai-compatible'>, string>
> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.ai/v1',
  // Alibaba Cloud Model Studio, international (Singapore); mainland China is another address.
  qwencloud: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'xiaomi-mimo': 'https://api.xiaomimimo.com/v1',
  zai: 'https://api.z.ai/api/paas/v4',
};

export interface ProviderConnection {
  kind: ProviderKind;
  /** Required for first-party providers. An OpenAI-compatible server may need none (Ollama). */
  apiKey?: string;
  /** Required for OpenAI-compatible endpoints; defaults to DEFAULT_BASE_URLS otherwise. */
  baseURL?: string;
  /** Short name for an OpenAI-compatible endpoint, shown as the model's provider. */
  name?: string;
  /** Replaces global fetch, for tests and for request-level controls such as timeouts. */
  fetch?: typeof fetch;
  /** The stored credential this connection came from, for attributing usage to it. */
  configId?: string;
}

function requireKey(connection: ProviderConnection): string {
  if (connection.apiKey === undefined || connection.apiKey.trim() === '') {
    throw new ConfigError(`a ${connection.kind} credential needs an API key`);
  }
  return connection.apiKey;
}

function baseUrlFor(connection: ProviderConnection): string {
  if (connection.kind === 'openai-compatible') {
    if (connection.baseURL === undefined) {
      throw new ConfigError('an OpenAI-compatible credential needs a base URL');
    }
    return connection.baseURL;
  }
  return connection.baseURL ?? DEFAULT_BASE_URLS[connection.kind];
}

/** A language model for `modelId` on this connection. Constructing one makes no request. */
export function languageModel(connection: ProviderConnection, modelId: string): LanguageModelV4 {
  const baseURL = baseUrlFor(connection);
  const fetchOption = connection.fetch === undefined ? {} : { fetch: connection.fetch };
  switch (connection.kind) {
    case 'anthropic':
      return createAnthropic({ apiKey: requireKey(connection), baseURL, ...fetchOption })(modelId);
    case 'openai':
      // The Responses API is OpenAI's current interface and reports cached and reasoning tokens.
      return createOpenAI({ apiKey: requireKey(connection), baseURL, ...fetchOption }).responses(
        modelId,
      );
    case 'google':
      return createGoogleGenerativeAI({ apiKey: requireKey(connection), baseURL, ...fetchOption })(
        modelId,
      );
    case 'deepseek':
    case 'moonshot':
    case 'qwencloud':
    case 'xiaomi-mimo':
    case 'zai':
      return createOpenAICompatible({
        name: connection.kind,
        baseURL,
        apiKey: requireKey(connection),
        includeUsage: true,
        ...fetchOption,
      }).chatModel(modelId);
    case 'openai-compatible':
      return createOpenAICompatible({
        name: connection.name ?? 'openai-compatible',
        baseURL,
        ...(connection.apiKey === undefined || connection.apiKey === ''
          ? {}
          : { apiKey: connection.apiKey }),
        // Without this, compatible servers do not report token usage on streams.
        includeUsage: true,
        ...fetchOption,
      }).chatModel(modelId);
  }
}
