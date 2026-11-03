import {
  normalizeDomain,
  ProviderError,
  type Citation,
  type ProviderRequest,
  type ProviderResult,
  type Usage,
} from '../contracts/index.js';
import { estimateCost } from './pricing.js';
import { number, object, text } from './http.js';

export interface LiveOptions {
  apiKey: string;
  model: string;
  fetch: typeof fetch;
  timeoutMs: number;
  anthropicVersion: string;
}
export function citation(value: unknown): Citation | null {
  const source = object(value);
  const url = text(source.url);
  try {
    return {
      url,
      domain: normalizeDomain(url),
      ...(typeof source.title === 'string' ? { title: source.title } : {}),
      ...(number(source.start_index) !== null
        ? { startIndex: Number(source.start_index) }
        : {}),
      ...(number(source.end_index) !== null
        ? { endIndex: Number(source.end_index) }
        : {}),
    };
  } catch {
    return null;
  }
}
export function result(
  request: ProviderRequest,
  rawPayload: unknown,
  answerText: string,
  citations: Citation[],
  usage: Usage,
  startedAt: string,
  requestId: string | null,
  availability: 'yes' | 'no' | 'unknown' = citations.length ? 'yes' : 'no',
): ProviderResult {
  if (!answerText.trim())
    throw new ProviderError({
      category: 'unknown',
      retryable: false,
      message: 'Provider returned no answer',
    });
  return {
    provider: request.provider,
    integration: 'live',
    model: request.model,
    rawPayload,
    answerText,
    citations,
    citationsAvailable: availability,
    usage,
    cost: estimateCost(request.model, usage),
    requestId,
    startedAt,
    completedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - Date.parse(startedAt)),
  };
}
