import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  createProviderAdapters,
  modelForProvider,
} from '../../src/providers/index.js';
import { estimateCost, PRICE_TABLE } from '../../src/providers/pricing.js';
import type {
  ProviderId,
  ProviderRequest,
  ProviderKeyResolver,
} from '../../src/contracts/index.js';
import { foundationEnv } from '../foundation/fixtures.js';
import { synthetic } from './fixtures.js';

const config = loadConfig(foundationEnv);
const resolver: ProviderKeyResolver = {
  resolve: async (provider) => ({
    provider,
    mode: 'live',
    keySource: 'env',
    apiKey: 'synthetic-review-key',
  }),
};
const request = (provider: ProviderId): ProviderRequest => ({
  provider,
  model: modelForProvider(config, provider),
  questionText: 'Best CRM?',
  questionId: 'synthetic',
  executionKey: 'a'.repeat(64),
  settings: { webSearch: true },
  timeoutMs: 1000,
});
const execute = (
  provider: ProviderId,
  bodies: { body: unknown; status?: number }[],
) => {
  const fetch = vi.fn(async () => {
    const item = bodies.shift();
    if (!item) throw new DOMException('Synthetic timeout', 'TimeoutError');
    return new Response(JSON.stringify(item.body), {
      status: item.status ?? 200,
    });
  });
  return {
    fetch,
    result: createProviderAdapters({ config, resolver, fetch })[
      provider
    ].execute(request(provider), new AbortController().signal),
  };
};

describe('independent provider review regressions (synthetic only)', () => {
  it.each([
    ['unavailable', 'server'],
    ['too_many_requests', 'rate_limit'],
    ['max_uses_exceeded', 'invalid_request'],
  ])(
    'rejects object-shaped Anthropic search error %s beside answer text',
    async (code, category) => {
      await expect(
        execute('anthropic', [
          {
            body: {
              ...synthetic.anthropic,
              content: [
                ...synthetic.anthropic.content,
                {
                  type: 'web_search_tool_result',
                  content: {
                    type: 'web_search_tool_result_error',
                    error_code: code,
                  },
                },
              ],
            },
          },
        ]).result,
      ).rejects.toMatchObject({ category });
    },
  );
  it.each([429, 529, 400, 'timeout', 'exhausted'])(
    'preserves paid Anthropic responses on continuation failure %s',
    async (failure) => {
      const pause = { ...synthetic.anthropic, stop_reason: 'pause_turn' };
      const bodies =
        failure === 'exhausted'
          ? Array.from({ length: 4 }, () => ({ body: pause }))
          : [
              { body: pause },
              ...(typeof failure === 'number'
                ? [{ body: { error: { type: 'synthetic' } }, status: failure }]
                : []),
            ];
      const expectedUsage = {
        inputTokens: failure === 'exhausted' ? 400 : 100,
        outputTokens: failure === 'exhausted' ? 80 : 20,
        toolCalls: failure === 'exhausted' ? 4 : 1,
      };
      const error: unknown = await execute('anthropic', bodies).result.catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({
        retryable: false,
        httpStatus: undefined,
        partial: {
          usage: expectedUsage,
          cost: estimateCost(config.ANTHROPIC_MODEL, expectedUsage),
          rawPayload: { responses: expect.any(Array) },
        },
      });
    },
  );
  it('uses a priced Anthropic default', () => {
    expect(config.ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
    expect(PRICE_TABLE).toHaveProperty(config.ANTHROPIC_MODEL);
  });
  it('translates Gemini multipart UTF-8 offsets and preserves repeated supports', async () => {
    const response = {
      ...synthetic.gemini,
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: 'é CRM' }, { text: 'Attio and Attio' }] },
          groundingMetadata: {
            ...synthetic.gemini.candidates[0]!.groundingMetadata,
            groundingSupports: [
              {
                segment: { partIndex: 1, startIndex: 0, endIndex: 5 },
                groundingChunkIndices: [0],
              },
              {
                segment: { partIndex: 1, startIndex: 10, endIndex: 15 },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
    };
    const result = await execute('gemini', [{ body: response }]).result;
    expect(result.citations).toHaveLength(2);
    for (const c of result.citations)
      expect(
        Buffer.from(result.answerText)
          .subarray(c.startIndex, c.endIndex)
          .toString('utf8'),
      ).toBe('Attio');
    expect(result.rawPayload).toHaveProperty(
      'metadata.citationOffsetBasis',
      'joined-answer',
    );
    expect(result.rawPayload).toHaveProperty('response', response);
  });
  it('preserves OpenAI block provenance without projecting unverified offsets onto joined text', async () => {
    const response = {
      ...synthetic.openai,
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'é😀 first', annotations: [] },
          ],
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'HubSpot',
              annotations: synthetic.openai.output[1]!.content![0]!.annotations,
            },
          ],
        },
      ],
    };
    const result = await execute('openai', [{ body: response }]).result;
    expect(result.citations[0]).not.toHaveProperty('startIndex');
    expect(result.citations[0]).not.toHaveProperty('endIndex');
    expect(result.rawPayload).toMatchObject({
      response,
      metadata: {
        citationOffsetUnit: 'character-unverified',
        citationOffsetBasis: 'provider-text-block',
        citationProvenance: [
          {
            outputIndex: 1,
            contentIndex: 0,
            annotationIndex: 0,
            startIndex: 0,
            endIndex: 7,
          },
        ],
      },
    });
  });
});

// Worker regressions use the actual repository and adapter with deterministic fetches.
// The explicit fixture bound is synthetic evidence, not an operator setting or live bypass.
import {
  processExecution,
  type WorkerDependencies,
} from '../../src/workers/provider-worker.js';
import { createMongoBudgetGate } from '../../src/workers/live-budget.js';
import { createLogger } from '../../src/logging/index.js';
import { repositoryFixture } from '../db/fake-driver.js';
import { executionInput } from '../db/fixtures.js';
import {
  liveReservationBound,
  liveCostEstimate,
} from '../../src/providers/pricing.js';

async function workerFixture(
  provider: ProviderId,
  fetch: typeof globalThis.fetch,
  bound?: number,
) {
  const fixture = repositoryFixture();
  const silentConfig = loadConfig({ ...foundationEnv, LOG_LEVEL: 'silent' });
  const { execution } = await fixture.repository.createQueuedIfAbsent({
    ...executionInput,
    provider,
    model: modelForProvider(config, provider),
  });
  const deps: WorkerDependencies = {
    repository: fixture.repository,
    resolver,
    adapters: createProviderAdapters({ config: silentConfig, resolver, fetch }),
    config: silentConfig,
    logger: createLogger(silentConfig),
    budgetGate: createMongoBudgetGate(fixture.storage.spend),
    schedule: vi.fn(),
    pause: vi.fn(),
    persistenceWait: async () => {},
    ...(bound === undefined ? {} : { liveBudgetBound: () => bound }),
  };
  return {
    ...fixture,
    deps,
    execution,
    payload: {
      executionId: execution.id,
      executionKey: execution.executionKey,
    },
  };
}

describe('provider review worker and admission regressions', () => {
  it.each([429, 529, 400, 'timeout', 'exhausted'])(
    'retains paid evidence and reserves without rerunning a failed continuation %s',
    async (failure) => {
      const pause = { ...synthetic.anthropic, stop_reason: 'pause_turn' };
      let calls = 0;
      const fetch = vi.fn(async () => {
        calls++;
        if (calls === 1 || failure === 'exhausted')
          return new Response(JSON.stringify(pause));
        if (failure === 'timeout')
          throw new DOMException('Synthetic timeout', 'TimeoutError');
        return new Response(
          JSON.stringify({ error: { type: 'synthetic-continuation-failure' } }),
          { status: Number(failure) },
        );
      });
      const f = await workerFixture('anthropic', fetch, 0.1);
      await processExecution(f.payload, f.deps);
      await processExecution(f.payload, f.deps);
      const stored = await f.repository.getById(f.execution.id);
      expect(stored?.status).toBe('unknown_outcome');
      expect(stored?.rawResponseId).toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(failure === 'exhausted' ? 4 : 2);
      expect(f.deps.schedule).not.toHaveBeenCalled();
      expect(await f.repository.getSpendTotal()).toBe(0.1);
      const raw = await f.repository.getRawResponse(f.execution.id);
      expect(raw?.outputText).toContain('Close');
      expect(raw?.body).toMatchObject({
        usage: { inputTokens: failure === 'exhausted' ? 400 : 100 },
        cost: { totalUsd: expect.any(Number) },
        rawPayload: {
          responses: expect.any(Array),
          failure: { httpStatus: typeof failure === 'number' ? failure : null },
        },
      });
    },
  );
  it.each(['openai', 'perplexity', 'gemini', 'anthropic'] as const)(
    'fails closed for %s when no enforced billing bound is known',
    async (provider) => {
      const fetch = vi.fn(
        async () => new Response(JSON.stringify(synthetic[provider])),
      );
      const f = await workerFixture(provider, fetch);
      expect(liveCostEstimate(provider, f.execution.model)).not.toBeNull();
      expect(liveReservationBound(provider, f.execution.model)).toBeNull();
      await processExecution(f.payload, f.deps);
      expect(fetch).not.toHaveBeenCalled();
      expect(await f.repository.getSpendTotal()).toBe(0);
      expect((await f.repository.getById(f.execution.id))?.status).toBe('dead');
    },
  );
  it('rejects a near-cap Gemini request before four unbounded search queries can exceed its planning estimate', async () => {
    const fourQueries = {
      ...synthetic.gemini,
      candidates: [
        {
          ...synthetic.gemini.candidates[0],
          groundingMetadata: {
            ...synthetic.gemini.candidates[0]!.groundingMetadata,
            webSearchQueries: ['a', 'b', 'c', 'd'],
          },
        },
      ],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(fourQueries)));
    const f = await workerFixture('gemini', fetch);
    const prior = await f.repository.createQueuedIfAbsent({
      ...executionInput,
      questionId: 'prior-synthetic',
      provider: 'gemini',
      model: config.GEMINI_MODEL,
    });
    await f.repository.claim(prior.execution.executionKey, 1000);
    await f.repository.recordAttempt(prior.execution.id, {
      n: 1,
      integration: 'live',
      startedAt: new Date().toISOString(),
    });
    await f.repository.recordSpend({
      executionId: prior.execution.id,
      idempotencyKey: 'prior-synthetic',
      stage: 'provider',
      amountUsd: 1.94432,
    });
    expect(
      estimateCost(config.GEMINI_MODEL, {
        inputTokens: 100,
        outputTokens: 20,
        toolCalls: 4,
      }).totalUsd,
    ).toBeGreaterThan(liveCostEstimate('gemini', config.GEMINI_MODEL)!);
    await processExecution(f.payload, f.deps);
    expect(fetch).not.toHaveBeenCalled();
    expect(await f.repository.getSpendTotal()).toBe(1.94432);
  });
  it('sends all documented output/tool bounds with each Anthropic continuation', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            ...synthetic.anthropic,
            stop_reason: bodies.length === 1 ? 'pause_turn' : 'end_turn',
          }),
        );
      },
    );
    await createProviderAdapters({ config, resolver, fetch }).anthropic.execute(
      request('anthropic'),
      new AbortController().signal,
    );
    expect(bodies).toHaveLength(2);
    for (const body of bodies)
      expect(body).toMatchObject({ max_tokens: 512, tools: [{ max_uses: 1 }] });
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: 'Best CRM?' },
      { role: 'assistant', content: synthetic.anthropic.content },
    ]);
  });
});

describe('provider worker infrastructure failure classification', () => {
  it('retries a resolver infrastructure error without falling back to mock or making a provider call', async () => {
    const fetch = vi.fn();
    const f = await workerFixture('anthropic', fetch);
    vi.spyOn(f.deps.resolver, 'resolve').mockRejectedValueOnce(
      new Error('Synthetic key-store unavailable'),
    );
    await processExecution(f.payload, f.deps);
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'retry_wait',
    );
    expect(f.deps.schedule).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.deps.pause).not.toHaveBeenCalled();
    expect(await f.repository.getSpendTotal()).toBe(0);
  });
});

describe('provider follow-up review regressions (synthetic only)', () => {
  it('preserves both tool-only pause and empty terminal responses when final normalization fails', async () => {
    const responses = [
      {
        ...synthetic.anthropic,
        stop_reason: 'pause_turn',
        content: [
          {
            type: 'server_tool_use',
            id: 'synthetic-search',
            name: 'web_search',
            input: { query: 'CRM' },
          },
        ],
      },
      { ...synthetic.anthropic, content: [] },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(responses[fetch.mock.calls.length - 1])),
    );
    const f = await workerFixture('anthropic', fetch, 0.1);
    await processExecution(f.payload, f.deps);
    await processExecution(f.payload, f.deps);
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    expect(
      (await f.repository.getRawResponse(f.execution.id))?.body,
    ).toMatchObject({
      answerText: '',
      usage: { inputTokens: 200, outputTokens: 40, toolCalls: 2 },
      rawPayload: { responses, metadata: { incomplete: true } },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.deps.schedule).not.toHaveBeenCalled();
    expect(await f.repository.getSpendTotal()).toBe(0.1);
  });
  it.each(['before-insert', 'after-insert'])(
    'retries partial evidence persistence once after a transient %s failure',
    async (timing) => {
      const pause = { ...synthetic.anthropic, stop_reason: 'pause_turn' };
      const fetch = vi.fn(async () =>
        fetch.mock.calls.length === 1
          ? new Response(JSON.stringify(pause))
          : new Response(
              JSON.stringify({
                error: { type: 'synthetic-continuation-failure' },
              }),
              { status: 529 },
            ),
      );
      const f = await workerFixture('anthropic', fetch, 0.1);
      const persist = f.repository.savePartialRaw!.bind(f.repository);
      const save = vi
        .spyOn(f.repository, 'savePartialRaw')
        .mockImplementationOnce(async (...args) => {
          if (timing === 'after-insert') await persist(...args);
          throw new Error('Synthetic partial persistence interruption');
        });
      await processExecution(f.payload, f.deps);
      await processExecution(f.payload, f.deps);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[0]?.[2]).toMatchObject({
        claimToken: expect.any(String),
      });
      expect(save.mock.calls[1]?.[2]).toEqual(save.mock.calls[0]?.[2]);
      expect((await f.repository.getById(f.execution.id))?.status).toBe(
        'unknown_outcome',
      );
      expect(
        (await f.repository.getRawResponse(f.execution.id))?.body,
      ).toMatchObject({
        usage: { inputTokens: 100 },
        rawPayload: { responses: [pause] },
      });
      expect(f.storage.raw.rows).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(f.deps.schedule).not.toHaveBeenCalled();
      expect(await f.repository.getSpendTotal()).toBe(0.1);
    },
  );
  it('bounds persistent partial-evidence write failures and leaves reserved unknown work without provider replay', async () => {
    const fetch = vi.fn(async () =>
      fetch.mock.calls.length === 1
        ? new Response(
            JSON.stringify({
              ...synthetic.anthropic,
              stop_reason: 'pause_turn',
            }),
          )
        : new Response('{}', { status: 529 }),
    );
    const f = await workerFixture('anthropic', fetch, 0.1);
    const save = vi
      .spyOn(f.repository, 'savePartialRaw')
      .mockRejectedValue(new Error('Synthetic persistent storage failure'));
    const log = vi.spyOn(f.deps.logger, 'error');
    await expect(processExecution(f.payload, f.deps)).rejects.toThrow(
      'Partial response persistence exhausted; outcome requires reconciliation',
    );
    await processExecution(f.payload, f.deps);
    expect(save).toHaveBeenCalledTimes(8);
    expect(log).toHaveBeenCalledWith(
      { stage: 'partial_evidence.unstored', writes: 8 },
      'Partial response evidence could not be persisted; reconciliation required',
    );
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    expect(await f.repository.getRawResponse(f.execution.id)).toBeNull();
    expect(await f.repository.getSpendTotal()).toBe(0.1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.deps.schedule).not.toHaveBeenCalled();
  });
  for (const continuation of [false, true])
    it.each([
      'max_tokens',
      'model_context_window_exceeded',
      'tool_use',
      'unexpected_stop',
      null,
    ])(
      `preserves incomplete paid termination %s (continuation=${continuation})`,
      async (stopReason) => {
        const terminal = { ...synthetic.anthropic, stop_reason: stopReason };
        const pause = { ...synthetic.anthropic, stop_reason: 'pause_turn' };
        const responses = continuation ? [pause, terminal] : [terminal];
        const fetch = vi.fn(
          async () =>
            new Response(
              JSON.stringify(responses[fetch.mock.calls.length - 1]),
            ),
        );
        const f = await workerFixture('anthropic', fetch, 0.1);
        await processExecution(f.payload, f.deps);
        await processExecution(f.payload, f.deps);
        expect((await f.repository.getById(f.execution.id))?.status).toBe(
          'unknown_outcome',
        );
        expect(
          (await f.repository.getRawResponse(f.execution.id))?.body,
        ).toMatchObject({
          usage: {
            inputTokens: continuation ? 200 : 100,
            outputTokens: continuation ? 40 : 20,
            toolCalls: continuation ? 2 : 1,
          },
          rawPayload: { responses, metadata: { incomplete: true } },
        });
        expect(fetch).toHaveBeenCalledTimes(continuation ? 2 : 1);
        expect(f.deps.schedule).not.toHaveBeenCalled();
        expect(await f.repository.getSpendTotal()).toBe(0.1);
      },
    );
});

describe('received incomplete OpenAI and Gemini evidence', () => {
  it.each(['incomplete', 'failed'])(
    'retains OpenAI %s response, citations and usage without replay',
    async (status) => {
      const response = { ...synthetic.openai, status };
      const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
      const f = await workerFixture('openai', fetch, 0.1);
      await processExecution(f.payload, f.deps);
      await processExecution(f.payload, f.deps);
      expect((await f.repository.getById(f.execution.id))?.status).toBe(
        'unknown_outcome',
      );
      const raw = await f.repository.getRawResponse(f.execution.id);
      expect(raw?.body).toMatchObject({
        rawPayload: {
          response,
          metadata: {
            incomplete: true,
            citationOffsetUnit: 'character-unverified',
          },
        },
        usage: { inputTokens: 100, outputTokens: 20, toolCalls: 1 },
      });
      expect(raw?.outputText).toBe('HubSpot is an option.');
      expect(raw?.citations).toHaveLength(1);
      expect(raw?.citations[0]?.domain).toBe('hubspot.com');
      expect(fetch).toHaveBeenCalledOnce();
      expect(f.deps.schedule).not.toHaveBeenCalled();
      expect(await f.repository.getSpendTotal()).toBe(0.1);
    },
  );
  it.each([
    'MAX_TOKENS',
    'SAFETY',
    'RECITATION',
    'OTHER',
    'BLOCKLIST',
    null,
    undefined,
  ])(
    'retains incomplete Gemini finishReason %s without accepting partial text as success',
    async (finishReason) => {
      const response = {
        ...synthetic.gemini,
        candidates: [{ ...synthetic.gemini.candidates[0], finishReason }],
      };
      const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
      const f = await workerFixture('gemini', fetch, 0.1);
      await processExecution(f.payload, f.deps);
      await processExecution(f.payload, f.deps);
      expect((await f.repository.getById(f.execution.id))?.status).toBe(
        'unknown_outcome',
      );
      const raw = await f.repository.getRawResponse(f.execution.id);
      expect(raw?.body).toMatchObject({
        rawPayload: {
          response: JSON.parse(JSON.stringify(response)) as unknown,
          metadata: { incomplete: true, citationOffsetUnit: 'utf8-bytes' },
        },
        usage: { inputTokens: 100, outputTokens: 20, toolCalls: 1 },
      });
      expect(raw?.outputText).toBe('Attio is an option.');
      expect(raw?.citations[0]?.domain).toBe('attio.com');
      expect(fetch).toHaveBeenCalledOnce();
      expect(f.deps.schedule).not.toHaveBeenCalled();
      expect(await f.repository.getSpendTotal()).toBe(0.1);
    },
  );
});
