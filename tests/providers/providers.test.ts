import { describe, expect, it, vi } from 'vitest';
import {
  createProviderAdapters,
  modelForProvider,
} from '../../src/providers/index.js';
import {
  ProviderIdSchema,
  ProviderResultSchema,
  type ProviderId,
  type ProviderRequest,
  type ProviderKeyResolver,
} from '../../src/contracts/index.js';
import { loadConfig } from '../../src/config/index.js';
import { foundationEnv } from '../foundation/fixtures.js';
import { synthetic } from './fixtures.js';

const config = loadConfig(foundationEnv);
const makeRequest = (provider: ProviderId): ProviderRequest => ({
  provider,
  model: modelForProvider(config, provider),
  questionText: 'Best CRM?',
  questionId: 'q1',
  executionKey: 'a'.repeat(64),
  settings: { webSearch: true },
  timeoutMs: 1000,
});
const liveResolver: ProviderKeyResolver = {
  resolve: async (provider) =>
    provider === 'google_ai'
      ? { provider, mode: 'mock', keySource: 'none' }
      : {
          provider,
          mode: 'live',
          keySource: 'env',
          apiKey: 'placeholder-provider-key',
        },
};
const responseFetch = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));

describe('provider adapters with synthetic fetch only', () => {
  it.each(ProviderIdSchema.options)(
    '%s mock satisfies the contract, costs zero and calls no fetch',
    async (provider) => {
      const fetch = vi.fn();
      const adapters = createProviderAdapters({
        config,
        fetch,
        resolver: {
          resolve: async (p) => ({
            provider: p,
            mode: 'mock',
            keySource: 'none',
          }),
        },
      });
      const result = await adapters[provider].execute(
        makeRequest(provider),
        new AbortController().signal,
      );
      expect(ProviderResultSchema.parse(result).integration).toBe('mock');
      expect(result.cost.totalUsd).toBe(0);
      expect(result.rawPayload).toHaveProperty('mock', true);
      expect(result.usage.inputTokens).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  for (const provider of [
    'openai',
    'perplexity',
    'gemini',
    'anthropic',
  ] as const) {
    it(`${provider} preserves a successful answer without inventing citations`, async () => {
      const responses = {
        openai: {
          ...synthetic.openai,
          output: [
            { type: 'web_search_call' },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Synthetic answer without sources',
                  annotations: [],
                },
              ],
            },
          ],
        },
        perplexity: {
          ...synthetic.perplexity,
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Synthetic answer without sources',
                },
              ],
            },
          ],
        },
        gemini: {
          ...synthetic.gemini,
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [{ text: 'Synthetic answer without sources' }],
              },
              groundingMetadata: {},
            },
          ],
        },
        anthropic: {
          ...synthetic.anthropic,
          content: [
            {
              type: 'text',
              text: 'Synthetic answer without sources',
              citations: [],
            },
          ],
        },
      };
      const adapter = createProviderAdapters({
        config,
        resolver: liveResolver,
        fetch: responseFetch(responses[provider]),
      })[provider];
      const result = await adapter.execute(
        makeRequest(provider),
        new AbortController().signal,
      );
      expect(result.answerText).toContain('Synthetic answer');
      expect(result.citations).toEqual([]);
      expect(result.citationsAvailable).toBe(
        provider === 'gemini' ? 'unknown' : 'no',
      );
    });
    it(`${provider} normalizes a synthetic live response with citations`, async () => {
      const adapters = createProviderAdapters({
        config,
        resolver: liveResolver,
        fetch: responseFetch(synthetic[provider]),
      });
      const result = await adapters[provider].execute(
        makeRequest(provider),
        new AbortController().signal,
      );
      expect(ProviderResultSchema.parse(result).integration).toBe('live');
      expect(result.citationsAvailable).toBe('yes');
      expect(result.citations).toHaveLength(1);
      if (provider === 'gemini') {
        expect(result.citations[0]?.domain).toBe('attio.com');
        expect(result.rawPayload).toHaveProperty(
          'metadata.citationOffsetUnit',
          'utf8-bytes',
        );
      }
      if (provider === 'anthropic')
        expect(result.citations[0]).not.toHaveProperty('startIndex');
    });
    it(`${provider} safely handles rate-limit, auth and timeout failures`, async () => {
      for (const status of [429, 401]) {
        const adapters = createProviderAdapters({
          config,
          resolver: liveResolver,
          fetch: responseFetch({ error: { code: 'rate_limit' } }, status, {
            'retry-after': '2',
          }),
        });
        await expect(
          adapters[provider].execute(
            makeRequest(provider),
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({
          category: status === 429 ? 'rate_limit' : 'auth',
          retryable: status === 429,
          retryAfterMs: 2000,
        });
      }
      const adapters = createProviderAdapters({
        config,
        resolver: liveResolver,
        fetch: vi.fn(async () => {
          throw new DOMException('Synthetic timeout', 'TimeoutError');
        }),
      });
      await expect(
        adapters[provider].execute(
          makeRequest(provider),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ category: 'timeout', retryable: true });
    });
  }
  it('rejects incomplete OpenAI and credit-limit 429 without a retry', async () => {
    for (const [body, status] of [
      [{ ...synthetic.openai, status: 'incomplete' }, 200],
      [{ error: { code: 'credit_balance_exhausted' } }, 429],
    ] as const) {
      const adapter = createProviderAdapters({
        config,
        resolver: liveResolver,
        fetch: responseFetch(body, status),
      }).openai;
      await expect(
        adapter.execute(makeRequest('openai'), new AbortController().signal),
      ).rejects.toMatchObject({ retryable: false });
    }
  });
  it('does not invent Gemini citations when grounding is empty; daily quota is permanent', async () => {
    const empty = {
      ...synthetic.gemini,
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: 'Answer without citations' }] },
          groundingMetadata: {},
        },
      ],
    };
    const adapter = createProviderAdapters({
      config,
      resolver: liveResolver,
      fetch: responseFetch(empty),
    }).gemini;
    expect(
      (
        await adapter.execute(
          makeRequest('gemini'),
          new AbortController().signal,
        )
      ).citationsAvailable,
    ).toBe('unknown');
    const limited = createProviderAdapters({
      config,
      resolver: liveResolver,
      fetch: responseFetch({ error: { code: 'quota_exceeded' } }, 429),
    }).gemini;
    await expect(
      limited.execute(makeRequest('gemini'), new AbortController().signal),
    ).rejects.toMatchObject({ retryable: false });
  });
  it('parses Anthropic 200 search errors and caps pause_turn continuations', async () => {
    const error = createProviderAdapters({
      config,
      resolver: liveResolver,
      fetch: responseFetch({
        content: [
          {
            type: 'web_search_tool_result',
            content: [
              {
                type: 'web_search_tool_result_error',
                error_code: 'unavailable',
              },
            ],
          },
        ],
      }),
    }).anthropic;
    await expect(
      error.execute(makeRequest('anthropic'), new AbortController().signal),
    ).rejects.toMatchObject({ category: 'server', retryable: false });
    const fetch = responseFetch({
      ...synthetic.anthropic,
      stop_reason: 'pause_turn',
    });
    const adapter = createProviderAdapters({
      config,
      resolver: liveResolver,
      fetch,
    }).anthropic;
    await expect(
      adapter.execute(makeRequest('anthropic'), new AbortController().signal),
    ).rejects.toMatchObject({ category: 'unknown', retryable: false });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
