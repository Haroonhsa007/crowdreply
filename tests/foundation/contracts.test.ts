import { describe, expect, it } from 'vitest';
import {
  buildExecutionKey,
  utcRunDate,
  normalizeDomain,
  InvalidCitationUrlError,
  UsageSchema,
  CostBreakdownSchema,
  isRetryable,
  ProviderError,
  PROVIDER_LIVE_SUPPORT,
  ExecutionStatusSchema,
  ExtractionStatusSchema,
  ProviderRequestSchema,
  ProviderResultSchema,
  ExecutionSchema,
  QueueJobPayloadSchema,
  RawResponseSchema,
  CitationSchema,
} from '../../src/contracts/index.js';

const identity = {
  questionId: 'q-1',
  questionVersion: 1,
  provider: 'openai' as const,
  modelSettingsVersion: 'settings-v1',
  runDate: '2026-11-02',
};

describe('execution identity and UTC dates', () => {
  it('is stable, defaults runSeq to zero and is a SHA-256 hex key', () => {
    expect(buildExecutionKey(identity)).toMatch(/^[a-f0-9]{64}$/);
    expect(buildExecutionKey(identity)).toBe(
      buildExecutionKey({ ...identity, runSeq: 0 }),
    );
  });
  it.each([
    { questionId: 'q-2' },
    { questionVersion: 2 },
    { provider: 'gemini' as const },
    { modelSettingsVersion: 'settings-v2' },
    { runDate: '2026-11-03' },
    { runSeq: 1 },
  ])('changes when any field changes: %j', (change) => {
    expect(buildExecutionKey({ ...identity, ...change })).not.toBe(
      buildExecutionKey(identity),
    );
  });
  it.each(['2026-2-01', '2026-02-30', '2026-11-02T00:00:00Z', 'not-a-date'])(
    'rejects invalid date %s',
    (runDate) => {
      expect(() => buildExecutionKey({ ...identity, runDate })).toThrow();
    },
  );
  it('does not confuse embedded delimiters between identity fields', () => {
    expect(
      buildExecutionKey({
        ...identity,
        questionId: 'a|b',
        modelSettingsVersion: 'c',
      }),
    ).not.toBe(
      buildExecutionKey({
        ...identity,
        questionId: 'a',
        modelSettingsVersion: 'b|c',
      }),
    );
  });
  it('uses UTC at a local day boundary and rejects invalid dates', () => {
    expect(utcRunDate(new Date('2026-11-02T23:30:00-06:00'))).toBe(
      '2026-11-03',
    );
    expect(() => utcRunDate(new Date('invalid'))).toThrow(RangeError);
  });
});

describe('provider contracts', () => {
  it('normalizes case, www, ports and paths', () => {
    expect(normalizeDomain('https://WWW.Example.COM:8443/a?q=1')).toBe(
      'example.com',
    );
  });
  it.each([
    'invalid-url',
    'ftp://example.com/file',
    'https://name:fixture@example.com',
  ])('rejects invalid/unsafe URL %s with a typed safe error', (value) => {
    expect(() => normalizeDomain(value)).toThrow(InvalidCitationUrlError);
    try {
      normalizeDomain(value);
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });
  it('preserves every unknown usage and cost field as null; missing fields fail', () => {
    expect(
      UsageSchema.parse({
        inputTokens: null,
        outputTokens: null,
        toolCalls: null,
      }),
    ).toEqual({ inputTokens: null, outputTokens: null, toolCalls: null });
    expect(
      CostBreakdownSchema.parse({
        tokensUsd: null,
        toolsUsd: null,
        totalUsd: null,
      }),
    ).toEqual({ tokensUsd: null, toolsUsd: null, totalUsd: null });
    expect(
      UsageSchema.safeParse({ inputTokens: null, outputTokens: null }).success,
    ).toBe(false);
    expect(
      CostBreakdownSchema.safeParse({ tokensUsd: null, totalUsd: null })
        .success,
    ).toBe(false);
    expect(
      UsageSchema.safeParse({
        inputTokens: -1,
        outputTokens: null,
        toolCalls: null,
      }).success,
    ).toBe(false);
  });
  it.each([
    ['rate_limit', true],
    ['timeout', true],
    ['server', true],
    ['auth', false],
    ['invalid_request', false],
    ['unknown', false],
  ] as const)('retry policy for %s = %s', (category, expected) => {
    expect(isRetryable(category)).toBe(expected);
  });
  it('does not expose arbitrary upstream text or permit auth retries', () => {
    const error = new ProviderError({
      category: 'auth',
      retryable: true,
      message: 'fixture-only-sensitive-value',
      httpStatus: 401,
    });
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('fixture-only-sensitive-value');
    expect(error.httpStatus).toBe(401);
  });
  it('declares four live-capable providers and keeps provider/extraction lifecycle separate', () => {
    expect(Object.values(PROVIDER_LIVE_SUPPORT).filter(Boolean)).toHaveLength(
      4,
    );
    expect(PROVIDER_LIVE_SUPPORT.google_ai).toBe(false);
    expect(ExecutionStatusSchema.parse('unknown_outcome')).toBe(
      'unknown_outcome',
    );
    expect(ExecutionStatusSchema.safeParse('extraction_failed').success).toBe(
      false,
    );
    expect(ExtractionStatusSchema.parse('extraction_failed')).toBe(
      'extraction_failed',
    );
  });
  it('validates provider request/result, queue and raw payloads without zero-filling citation absence', () => {
    const executionKey = buildExecutionKey(identity);
    expect(
      ProviderRequestSchema.parse({
        questionText: 'Which CRM?',
        questionId: 'q-1',
        executionKey,
        provider: 'openai',
        model: 'fixture-model',
        settings: { webSearch: true },
        timeoutMs: 1000,
      }).settings.webSearch,
    ).toBe(true);
    const rawPayload = { original: { untouched: ['fixture'] } };
    const result = ProviderResultSchema.parse({
      provider: 'openai',
      integration: 'live',
      model: 'fixture-model',
      rawPayload,
      answerText: 'Fixture answer',
      citations: [],
      citationsAvailable: 'no',
      usage: { inputTokens: null, outputTokens: null, toolCalls: null },
      cost: { tokensUsd: null, toolsUsd: null, totalUsd: null },
      latencyMs: 10,
      requestId: null,
      startedAt: '2026-11-02T00:00:00Z',
      completedAt: '2026-11-02T00:00:01Z',
    });
    expect(result.rawPayload).toBe(rawPayload);
    expect(result.citationsAvailable).toBe('no');
    expect(
      QueueJobPayloadSchema.parse({ executionId: 'e-1', executionKey }),
    ).toEqual({ executionId: 'e-1', executionKey });
    expect(
      RawResponseSchema.parse({
        executionId: 'e-1',
        body: rawPayload,
        outputText: 'Fixture answer',
        citations: [],
        providerResponseId: null,
        createdAt: '2026-11-02T00:00:01Z',
      }).body,
    ).toBe(rawPayload);
  });
  it('requires raw persistence reference before succeeded state', () => {
    const execution = {
      id: 'e-1',
      ...identity,
      questionText: 'Which CRM?',
      model: 'fixture-model',
      runSeq: 0,
      executionKey: buildExecutionKey(identity),
      settings: { webSearch: true },
      status: 'succeeded',
      extractionStatus: 'pending',
      attempts: [],
      citationsAvailable: 'unknown',
      createdAt: '2026-11-02T00:00:00Z',
      updatedAt: '2026-11-02T00:00:01Z',
    };
    expect(ExecutionSchema.safeParse(execution).success).toBe(false);
    expect(
      ExecutionSchema.safeParse({ ...execution, rawResponseId: 'raw-1' })
        .success,
    ).toBe(true);
  });
  it('rejects reversed citation offsets', () => {
    expect(
      CitationSchema.safeParse({
        url: 'https://example.com',
        domain: 'example.com',
        startIndex: 5,
        endIndex: 2,
      }).success,
    ).toBe(false);
  });
});
