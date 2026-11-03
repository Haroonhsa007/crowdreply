import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import * as c from '../../src/contracts/index.js';
import { loadConfig, redactedConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { foundationEnv } from './fixtures.js';

const input = {
  questionId: 'q1',
  questionText: 'Best CRM?',
  questionVersion: 1,
  provider: 'openai' as const,
  model: 'fixture-model',
  modelSettingsVersion: 'v1',
  runDate: '2026-11-02',
  settings: { webSearch: true },
};
const view = {
  id: 'e1',
  executionKey: c.buildExecutionKey({
    questionId: input.questionId,
    questionVersion: input.questionVersion,
    provider: input.provider,
    modelSettingsVersion: input.modelSettingsVersion,
    runDate: input.runDate,
  }),
  questionText: 'Best CRM?',
  provider: 'openai',
  model: 'fixture-model',
  status: 'queued',
  extractionStatus: 'pending',
  citationsAvailable: 'unknown',
  attemptCount: 0,
  createdAt: '2026-11-02T00:00:00Z',
};

describe('frozen contract addendum', () => {
  it('validates creation defaults, strict fields and UTC calendar dates', () => {
    expect(c.CreateExecutionInputSchema.parse(input).runSeq).toBe(0);
    expect(
      c.CreateExecutionInputSchema.safeParse({ ...input, unknown: true })
        .success,
    ).toBe(false);
    expect(
      c.CreateExecutionInputSchema.safeParse({
        ...input,
        runDate: '2026-02-30',
      }).success,
    ).toBe(false);
  });
  it('accepts retry metadata and retains raw-before-success requirement', () => {
    const execution = {
      ...input,
      ...view,
      questionVersion: 1,
      runSeq: 0,
      status: 'retry_wait',
      retryAt: '2026-11-02T01:00:00Z',
      lastErrorCategory: 'timeout',
      attempts: [],
      updatedAt: view.createdAt,
    };
    expect(c.ExecutionSchema.safeParse(execution).success).toBe(true);
    expect(
      c.ExecutionSchema.safeParse({ ...execution, status: 'succeeded' })
        .success,
    ).toBe(false);
  });
  it('restricts API views and nested raw projections; paginates safely', () => {
    expect(c.ApiExecutionViewSchema.parse(view).integration).toBeUndefined();
    for (const key of ['body', 'rawPayload', 'apiKey'])
      expect(
        c.ApiExecutionViewSchema.safeParse({ ...view, [key]: 'fixture' })
          .success,
      ).toBe(false);
    expect(
      c.ApiExecutionViewSchema.safeParse({
        ...view,
        raw: {
          outputText: 'text',
          citations: [],
          providerResponseId: null,
          body: {},
        },
      }).success,
    ).toBe(false);
    expect(
      c.ApiExecutionListResponseSchema.parse({
        items: [view],
        nextBefore: 'cursor',
      }).items,
    ).toHaveLength(1);
  });
  it('validates submit defaults, length and strict input', () => {
    expect(
      c.ApiSubmitRequestSchema.parse({ questionText: 'Best CRM?' }),
    ).toMatchObject({ provider: 'openai', webSearch: true, force: false });
    for (const text of ['', 'x'.repeat(2001)])
      expect(
        c.ApiSubmitRequestSchema.safeParse({ questionText: text }).success,
      ).toBe(false);
    expect(
      c.ApiSubmitRequestSchema.safeParse({
        questionText: 'CRM',
        secret: 'fixture',
      }).success,
    ).toBe(false);
  });
  it('omits keys from safe access logs and rejects keys in API status', () => {
    const access = c.ResolvedProviderAccessSchema.parse({
      provider: 'openai',
      mode: 'live',
      keySource: 'user',
      apiKey: 'placeholder-user-key',
    });
    expect(c.toSafeLog(access)).toEqual({
      provider: 'openai',
      mode: 'live',
      keySource: 'user',
    });
    expect(
      c.ApiProviderStatusSchema.safeParse({
        ...c.toSafeLog(access),
        liveSupported: true,
        apiKey: 'placeholder-user-key',
      }).success,
    ).toBe(false);
    expect(
      c.ApiProviderStatusListResponseSchema.parse({
        items: [{ ...c.toSafeLog(access), liveSupported: true }],
      }).items,
    ).toHaveLength(1);
    expect(
      c.ApiSetProviderKeyRequestSchema.safeParse({
        provider: 'google_ai',
        apiKey: 'placeholder-user-key',
      }).success,
    ).toBe(false);
    expect(
      c.ApiSetProviderKeyRequestSchema.safeParse({
        provider: 'openai',
        apiKey: 'bad\nheader',
      }).success,
    ).toBe(false);
    expect(c.USER_KEY_TTL_SECONDS_MAX).toBe(3600);
  });
  it('proves repository and enqueuer implementations type-check', () => {
    const repository: c.ExecutionRepository = {
      createQueuedIfAbsent: async () => {
        throw new Error('Compile-time fixture only');
      },
      getById: async () => null,
      getRawResponse: async () => null,
      listRecent: async () => [],
      scheduleRetry: async () => {},
      listRecoverable: async () => [],
      claim: async () => null,
      recordAttempt: async () => {},
      saveRawAndComplete: async () => {
        throw new Error('Compile-time fixture only');
      },
      markDead: async () => {},
      markUnknownOutcome: async () => {},
      recordSpend: async () => {},
      getSpendTotal: async () => 0,
    };
    const enqueuer: c.ExecutionEnqueuer = { enqueue: async () => {} };
    expect(repository).toHaveProperty('createQueuedIfAbsent');
    expect(enqueuer).toHaveProperty('enqueue');
  });
});

describe('credential configuration and startup diagnostics', () => {
  it.each([
    'OPERATOR_PASSWORD',
    'SESSION_SECRET',
    'KEY_ENCRYPTION_SECRET',
    'MONGO_ROOT_PASSWORD',
    'REDIS_PASSWORD',
  ] as const)('rejects missing/short %s without values', (key) => {
    for (const value of [undefined, 'short']) {
      expect(() => loadConfig({ ...foundationEnv, [key]: value })).toThrow(key);
      try {
        loadConfig({ ...foundationEnv, [key]: value });
      } catch (error) {
        expect(String(error)).not.toContain('short');
      }
    }
  });
  it('rejects TTL over one hour and emits booleans, never credential names/values', () => {
    expect(() =>
      loadConfig({ ...foundationEnv, USER_KEY_TTL_SECONDS: '3601' }),
    ).toThrow();
    const config = loadConfig(foundationEnv);
    const safe = redactedConfig(config);
    expect(safe.providerKeysConfigured).toEqual({
      openai: false,
      perplexity: false,
      gemini: false,
      anthropic: false,
    });
    for (const [key, value] of Object.entries(foundationEnv)) {
      expect(safe).not.toHaveProperty(key);
      expect(JSON.stringify(safe)).not.toContain(value);
    }
    let output = '';
    const logger = createLogger(
      config,
      new Writable({
        write(chunk, _encoding, callback) {
          output += String(chunk);
          callback();
        },
      }),
    );
    logger.info({
      ...foundationEnv,
      nested: {
        SESSION_SECRET: foundationEnv.SESSION_SECRET,
        'x-api-key': 'placeholder-header-key',
      },
    });
    logger.info({ config: safe });
    for (const value of Object.values(foundationEnv))
      expect(output).not.toContain(value);
    expect(output).toContain('"openai":false');
    expect(output).toContain('"operatorLoginConfigured":true');
  });
});
