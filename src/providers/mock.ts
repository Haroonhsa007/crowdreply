import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { ProviderRequest, ProviderResult } from '../contracts/index.js';

const BRANDS = [
  ['HubSpot CRM', 'hubspot.com'],
  ['Pipedrive', 'pipedrive.com'],
  ['Attio', 'attio.com'],
  ['Close', 'close.com'],
  ['Salesforce Starter Suite', 'salesforce.com'],
] as const;
export async function executeMock(
  request: ProviderRequest,
  signal: AbortSignal,
  latencyMs = 0,
): Promise<ProviderResult> {
  const startedAt = new Date().toISOString();
  signal.throwIfAborted();
  if (latencyMs) await setTimeout(latencyMs, undefined, { signal });
  const seed = createHash('sha256')
    .update(`${request.provider}:${request.questionText}`)
    .digest();
  const offset = (seed[0] ?? 0) % BRANDS.length;
  const ranked = [...BRANDS.slice(offset), ...BRANDS.slice(0, offset)].slice(
    0,
    3,
  );
  const answerText = `Mock answer — synthetic provider output, not market evidence.\n${ranked.map(([brand], i) => `${i + 1}. ${brand}: a CRM option to evaluate for this buyer question.`).join('\n')}`;
  const citations = ranked.map(([title, domain]) => ({
    title,
    domain,
    url: `https://${domain}/`,
  }));
  const id = `mock-${seed.toString('hex').slice(0, 16)}`;
  const payloads = {
    openai: {
      id,
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: answerText,
              annotations: citations.map((c) => ({
                type: 'url_citation',
                ...c,
              })),
            },
          ],
        },
      ],
    },
    perplexity: {
      id,
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: answerText }],
        },
        { type: 'search_results', results: citations },
      ],
    },
    gemini: {
      candidates: [
        {
          content: { parts: [{ text: answerText }] },
          groundingMetadata: {
            groundingChunks: citations.map((c) => ({
              web: { uri: c.url, title: c.domain },
            })),
          },
        },
      ],
    },
    anthropic: {
      id,
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: answerText,
          citations: citations.map((c) => ({
            type: 'web_search_result_location',
            ...c,
          })),
        },
      ],
    },
    google_ai: {
      answer_markdown: answerText,
      text_blocks: [{ text: answerText, reference_indexes: [0, 1, 2] }],
      references: citations.map((c, index) => ({
        ...c,
        index,
        snippet: 'Synthetic mock reference',
      })),
      is_mock: true,
    },
  };
  return {
    provider: request.provider,
    integration: 'mock',
    model: request.model,
    rawPayload: { mock: true, ...payloads[request.provider] },
    answerText,
    citations,
    citationsAvailable: 'yes',
    usage: { inputTokens: null, outputTokens: null, toolCalls: null },
    cost: { tokensUsd: 0, toolsUsd: 0, totalUsd: 0 },
    latencyMs,
    requestId: id,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
