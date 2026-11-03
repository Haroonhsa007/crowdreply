import type { CostBreakdown, ProviderId, Usage } from '../contracts/index.js';

/** Research snapshot from PROVIDER_CAPABILITIES.md. Prices change; confirm before paid scale. */
export const PRICE_TABLE = {
  'gpt-6-luna': {
    input: 0.1,
    output: 0.5,
    search: 0.01,
    source: 'https://developers.openai.com/api/docs/pricing',
    asOf: '2026-11-02',
  },
  'perplexity/sonar': {
    input: 0.25,
    output: 2.5,
    search: 0.0025,
    source: 'https://docs.perplexity.ai',
    asOf: '2026-11-02',
  },
  'gemini-3.6-flash': {
    input: 0.75,
    output: 3.75,
    search: 0.014,
    source: 'https://aistudio.google.com/docs/pricing',
    asOf: '2026-11-02',
  },
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    search: 0.01,
    source: 'https://platform.claude.com/docs/pricing',
    asOf: '2026-11-02',
  },
} satisfies Record<
  string,
  {
    input: number;
    output: number;
    search: number;
    source: string;
    asOf: string;
  }
>;
export function estimateCost(model: string, usage: Usage): CostBreakdown {
  const rate = PRICE_TABLE[model as keyof typeof PRICE_TABLE];
  if (!rate) return { tokensUsd: null, toolsUsd: null, totalUsd: null };
  const tokensUsd =
    usage.inputTokens === null || usage.outputTokens === null
      ? null
      : (usage.inputTokens * rate.input + usage.outputTokens * rate.output) /
        1_000_000;
  const toolsUsd =
    usage.toolCalls === null ? null : usage.toolCalls * rate.search;
  return {
    tokensUsd,
    toolsUsd,
    totalUsd:
      tokensUsd === null || toolsUsd === null ? null : tokensUsd + toolsUsd,
  };
}
/** Planning estimate only: neither token assumptions nor tool counts are a billing bound. */
export function liveCostEstimate(
  provider: ProviderId,
  model: string,
): number | null {
  if (provider === 'google_ai') return null;
  const rate = PRICE_TABLE[model as keyof typeof PRICE_TABLE];
  return rate
    ? 3 * rate.search + (8000 * rate.input + 2048 * rate.output) / 1_000_000
    : null;
}

/** No supplied provider documentation establishes a finite upper billable input
 * token bound for search results. Gemini also cannot bound grounded query count;
 * Perplexity exposes no tool-invocation cap in the researched request contract.
 * Paid admission remains closed until an enforceable end-to-end bound is verified.
 * A model being priced does not establish such a bound.
 */
export function liveReservationBound(
  _provider: ProviderId,
  _model: string,
): number | null {
  return null;
}
