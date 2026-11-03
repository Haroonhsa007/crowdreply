import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ProviderError } from '../../src/contracts/index.js';
import {
  requestJson,
  ProviderResponseError,
  type HttpOptions,
} from '../../src/providers/http.js';
import { executeAnthropic } from '../../src/providers/anthropic.js';
import { PaidProviderError } from '../../src/providers/paid-error.js';
import { synthetic } from './fixtures.js';

const marker = '[REDACTED]';
const fakeKey = 'obviously-fake-provider-"quoted"\\backslash-key';
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
    : [];
}
function options(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): HttpOptions {
  return {
    url: 'https://synthetic.invalid/provider',
    headers,
    body: { input: 'Synthetic question' },
    signal: new AbortController().signal,
    timeoutMs: 1000,
    fetch: vi.fn(async () => new Response(JSON.stringify(body), { status })),
  };
}

describe('provider credential reflection redaction using synthetic fetch only', () => {
  for (const [name, headerValue] of [
    ['aUtHoRiZaTiOn', `Bearer ${fakeKey}`],
    ['X-API-KEY', fakeKey],
    ['x-goog-api-key', fakeKey],
  ]) {
    it.each([200, 401])(
      `redacts ${name} exact credentials from HTTP %s nested values and property names`,
      async (status) => {
        const body = {
          error: {
            type: 'synthetic-auth',
            message: `Rejected credential ${fakeKey}`,
          },
          [fakeKey]: {
            [`nested-${fakeKey}`]: ['prefix ' + fakeKey, { retained: 42 }],
          },
          answer: 'Attio is an option.',
          metadata: { requestId: 'synthetic-request', unchanged: true },
        };
        const snapshot = structuredClone(body);
        let raw: unknown;
        if (status === 200)
          raw = (
            await requestJson(options(body, status, { [name!]: headerValue! }))
          ).json;
        else {
          const error: unknown = await requestJson(
            options(body, status, { [name!]: headerValue! }),
          ).catch((error: unknown) => error);
          expect(error).toBeInstanceOf(ProviderResponseError);
          if (!(error instanceof ProviderResponseError))
            throw new Error('Expected redacted provider error');
          expect(error).toMatchObject({
            category: 'auth',
            httpStatus: 401,
            retryable: false,
          });
          expect(error.message).not.toContain(fakeKey);
          raw = error.rawPayload;
        }
        expect(strings(raw).every((value) => !value.includes(fakeKey))).toBe(
          true,
        );
        expect(raw).toEqual({
          error: {
            type: 'synthetic-auth',
            message: `Rejected credential ${marker}`,
          },
          [marker]: {
            [`nested-${marker}`]: ['prefix ' + marker, { retained: 42 }],
          },
          answer: 'Attio is an option.',
          metadata: { requestId: 'synthetic-request', unchanged: true },
        });
        expect(body).toEqual(snapshot);
      },
    );
  }
  it('redacts top-level parsed strings and arrays, preserving unrelated scalars and metadata', async () => {
    for (const body of [
      fakeKey,
      [
        fakeKey,
        { [fakeKey]: `Bearer ${fakeKey}`, safe: 'Unrelated answer' },
        null,
        42,
        false,
      ],
    ]) {
      const raw = (
        await requestJson(
          options(body, 200, { Authorization: `Bearer ${fakeKey}` }),
        )
      ).json;
      expect(strings(raw).every((value) => !value.includes(fakeKey))).toBe(
        true,
      );
      expect(raw).toEqual(
        typeof body === 'string'
          ? marker
          : [
              marker,
              { [marker]: `Bearer ${marker}`, safe: 'Unrelated answer' },
              null,
              42,
              false,
            ],
      );
    }
  });
  it('classifies the original HTTP error before redacting a credential that equals its credit error code', async () => {
    const code = 'credit_balance_exhausted';
    const error: unknown = await requestJson(
      options({ error: { code, message: `Synthetic ${code}` } }, 429, {
        'x-api-key': code,
      }),
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      category: 'auth',
      httpStatus: 429,
      retryable: false,
    });
    if (!(error instanceof ProviderResponseError))
      throw new Error('Expected redacted provider error');
    expect(error.rawPayload).toEqual({
      error: { code: marker, message: `Synthetic ${marker}` },
    });
  });
  it('redacts every supplied credential, with overlapping tokens matched longest first', async () => {
    const shorter = 'obviously-fake-token';
    const longer = `${shorter}-extended`;
    const raw = (
      await requestJson(
        options({ values: [shorter, longer, fakeKey] }, 200, {
          Authorization: `Bearer ${longer}`,
          'x-api-key': shorter,
          'x-goog-api-key': fakeKey,
        }),
      )
    ).json;
    expect(raw).toEqual({ values: [marker, marker, marker] });
  });
  it('redacts reflected response-header values before adapters can store a request ID', async () => {
    const call = options({ answer: 'Unchanged answer' }, 200, {
      Authorization: `Bearer ${fakeKey}`,
    });
    call.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ answer: 'Unchanged answer' }), {
          headers: {
            'x-request-id': `synthetic-${fakeKey}`,
            'x-safe-metadata': 'Unchanged metadata',
          },
        }),
    );
    const response = await requestJson(call);
    expect(response.headers.get('x-request-id')).toBe(`synthetic-${marker}`);
    expect(response.headers.get('x-safe-metadata')).toBe('Unchanged metadata');
    expect(response.json).toEqual({ answer: 'Unchanged answer' });
  });
  it('preserves a redacted Anthropic paid continuation envelope and usage after an echoed HTTP error', async () => {
    const pause = {
      ...synthetic.anthropic,
      stop_reason: 'pause_turn',
      diagnostic: { [fakeKey]: `Synthetic echo ${fakeKey}` },
    };
    const failure = {
      error: {
        type: 'authentication_error',
        message: `Invalid key ${fakeKey}`,
        details: [{ [fakeKey]: { echo: fakeKey } }],
      },
      requestId: 'synthetic-error-id',
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify(fetch.mock.calls.length === 1 ? pause : failure),
          { status: fetch.mock.calls.length === 1 ? 200 : 401 },
        ),
    );
    const error: unknown = await executeAnthropic(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        questionId: 'synthetic-redaction',
        executionKey: 'a'.repeat(64),
        questionText: 'Best CRM?',
        settings: { webSearch: true },
        timeoutMs: 1000,
      },
      {
        apiKey: fakeKey,
        model: 'claude-sonnet-5-5',
        fetch,
        timeoutMs: 1000,
        anthropicVersion: '2023-06-01',
      },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PaidProviderError);
    if (!(error instanceof PaidProviderError))
      throw new Error('Expected paid evidence');
    expect(error).toMatchObject({
      category: 'auth',
      httpStatus: undefined,
      retryable: false,
    });
    expect(error.partial).toMatchObject({
      answerText: 'Close is an option.',
      usage: { inputTokens: 100, outputTokens: 20, toolCalls: 1 },
      rawPayload: {
        responses: [{ diagnostic: { [marker]: `Synthetic echo ${marker}` } }],
        failure: {
          category: 'auth',
          httpStatus: 401,
          response: {
            error: {
              type: 'authentication_error',
              message: `Invalid key ${marker}`,
              details: [{ [marker]: { echo: marker } }],
            },
            requestId: 'synthetic-error-id',
          },
        },
      },
    });
    expect(
      strings(error.partial).every((value) => !value.includes(fakeKey)),
    ).toBe(true);
    expect(error.message).not.toContain(fakeKey);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

async function listenLoopback(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Synthetic loopback listener unavailable'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/provider`);
    });
  });
}
async function closeLoopback(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe('provider HTTP redirect isolation with local synthetic servers', () => {
  it.each(['x-api-key', 'x-goog-api-key'])(
    'blocks cross-origin 307 forwarding of %s and the paid request body',
    async (headerName) => {
      let targetRequests = 0;
      let primaryRequests = 0;
      const target = createServer((request, response) => {
        targetRequests++;
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ answer: 'Synthetic redirected answer' }));
      });
      const targetUrl = await listenLoopback(target);
      const primary = createServer((request, response) => {
        primaryRequests++;
        request.resume();
        response.writeHead(307, { location: targetUrl });
        response.end();
      });
      try {
        const primaryUrl = await listenLoopback(primary);
        const error: unknown = await requestJson({
          ...options({}, 200, { [headerName]: fakeKey }),
          url: primaryUrl,
          fetch: globalThis.fetch,
        }).catch((error: unknown) => error);
        expect(primaryRequests).toBe(1);
        expect(targetRequests).toBe(0);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({
          category: 'server',
          retryable: true,
          httpStatus: undefined,
        });
        if (!(error instanceof ProviderError))
          throw new Error('Expected normalized redirect failure');
        expect(error.message).not.toContain(fakeKey);
        expect(error).not.toHaveProperty('cause');
        expect(error).not.toHaveProperty('rawPayload');
      } finally {
        await Promise.all([closeLoopback(primary), closeLoopback(target)]);
      }
    },
  );
});
