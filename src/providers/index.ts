import type { Config } from '../config/index.js';
import {
  ProviderIdSchema,
  ProviderRequestSchema,
  ResolvedProviderAccessSchema,
  ProviderError,
  type ProviderAdapter,
  type ProviderId,
  type ProviderKeyResolver,
  type ProviderRequest,
  type ProviderResult,
  type Execution,
  type ResolvedProviderAccess,
} from '../contracts/index.js';
import { executeOpenAI } from './openai.js';
import { executePerplexity } from './perplexity.js';
import { executeGemini } from './gemini.js';
import { executeAnthropic } from './anthropic.js';
import { executeMock } from './mock.js';
export { liveCostEstimate, liveReservationBound } from './pricing.js';

export interface RuntimeAdapter extends ProviderAdapter {
  /** Worker resolves once before budgeting; this prevents TTL expiry changing mode mid-attempt. */
  executeResolved(
    request: ProviderRequest,
    signal: AbortSignal,
    access: ResolvedProviderAccess,
  ): Promise<ProviderResult>;
}
export function modelForProvider(config: Config, provider: ProviderId): string {
  return {
    openai: config.OPENAI_MODEL,
    perplexity: config.PERPLEXITY_MODEL,
    gemini: config.GEMINI_MODEL,
    anthropic: config.ANTHROPIC_MODEL,
    google_ai: 'mock-google-ai-search',
  }[provider];
}
export function buildProviderRequest(
  execution: Execution,
  config: Config,
): ProviderRequest {
  return ProviderRequestSchema.parse({
    questionText: execution.questionText,
    questionId: execution.questionId,
    executionKey: execution.executionKey,
    provider: execution.provider,
    model: execution.model,
    settings: execution.settings,
    timeoutMs: config.PROVIDER_TIMEOUT_MS,
  });
}
export function createProviderAdapters(options: {
  resolver: ProviderKeyResolver;
  config: Config;
  fetch?: typeof fetch;
}): Record<ProviderId, RuntimeAdapter> {
  const live = {
    openai: executeOpenAI,
    perplexity: executePerplexity,
    gemini: executeGemini,
    anthropic: executeAnthropic,
  };
  const entries = ProviderIdSchema.options.map((provider) => {
    const executeResolved = async (
      request: ProviderRequest,
      signal: AbortSignal,
      value: ResolvedProviderAccess,
    ) => {
      const access = ResolvedProviderAccessSchema.parse(value);
      if (access.provider !== provider || request.provider !== provider)
        throw new ProviderError({
          category: 'invalid_request',
          retryable: false,
          message: 'Provider mismatch',
        });
      if (provider === 'google_ai' || access.mode === 'mock')
        return executeMock(request, signal);
      if (!access.apiKey)
        throw new ProviderError({
          category: 'auth',
          retryable: false,
          message: 'Provider key unavailable',
        });
      return live[provider](
        request,
        {
          apiKey: access.apiKey,
          model: request.model,
          fetch: options.fetch ?? globalThis.fetch,
          timeoutMs: request.timeoutMs,
          anthropicVersion: options.config.ANTHROPIC_VERSION,
        },
        signal,
      );
    };
    const adapter: RuntimeAdapter = {
      id: provider,
      integration: 'mock',
      executeResolved,
      async execute(request, signal) {
        return executeResolved(
          request,
          signal,
          await options.resolver.resolve(provider),
        );
      },
    };
    return [provider, adapter] as const;
  });
  return Object.fromEntries(entries) as Record<ProviderId, RuntimeAdapter>;
}
