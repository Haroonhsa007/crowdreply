import { describe, expect, it, vi } from 'vitest';
import { safeNextPath } from '../src/lib/auth/safe-next-path';
import { signSession, verifySession } from '../src/lib/auth/session';
import { verifyCredentials, loginLimiter } from '../src/lib/auth/credentials';
import { createApiClient } from '../src/lib/api/client';
import { proxy } from '../src/proxy';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
const secret = 'placeholder-session-secret-at-least-32-characters';
const config = {
  OPERATOR_USERNAME: 'fixture-operator',
  OPERATOR_PASSWORD: 'placeholder-password',
  OPERATOR_API_KEY: 'placeholder-api-key',
  SESSION_SECRET: secret,
  API_BASE_URL: 'http://localhost:3000',
  NODE_ENV: 'test' as const,
};
describe('dashboard trust boundary', () => {
  it.each([
    '//evil.test',
    '/\\evil.test',
    'https://evil.test',
    '/login',
    '/%2f%2fevil.test',
    '/%255cevil.test',
    '/login?next=/executions',
    '/a/../login',
  ])('rejects unsafe redirect %s', (value) =>
    expect(safeNextPath(value)).toBe('/'),
  );
  it('accepts safe relative navigation', () =>
    expect(safeNextPath('/executions?provider=openai')).toBe(
      '/executions?provider=openai',
    ));
  it('verifies signed sessions, expiry and tampering', async () => {
    const token = await signSession(secret, 1000000);
    expect(await verifySession(token, secret, 1000001)).toBe(true);
    expect(await verifySession(token + 'corrupt', secret, 1000001)).toBe(false);
    expect(await verifySession(token, secret, 1000000 + 3600000)).toBe(false);
  });
  it('compares both credentials and throttles repeated failures', () => {
    expect(
      verifyCredentials(
        'fixture-operator',
        'placeholder-password',
        config.OPERATOR_USERNAME,
        config.OPERATOR_PASSWORD,
      ),
    ).toBe(true);
    expect(
      verifyCredentials(
        'x',
        'y',
        config.OPERATOR_USERNAME,
        config.OPERATOR_PASSWORD,
      ),
    ).toBe(false);
    let now = 0;
    const limiter = loginLimiter(() => now);
    for (let i = 0; i < 5; i++) limiter.failed();
    expect(limiter.permitted()).toBe(false);
    now = 300001;
    expect(limiter.permitted()).toBe(true);
  });
  it('redirects unauthenticated proxy requests', async () => {
    vi.stubEnv('SESSION_SECRET', secret);
    const response = await proxy(
      new NextRequest('http://localhost:3001/executions'),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain(
      '/login?next=%2Fexecutions',
    );
  });
  it('normalizes HTTP, timeout and invalid response errors without leaking bodies', async () => {
    const schema = z.object({ ok: z.boolean() }).strict();
    const bad = createApiClient(
      config,
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ apiKey: 'placeholder-should-never-return' }),
            { status: 200 },
          ),
      ),
    );
    await expect(bad('/executions', schema)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
    const denied = createApiClient(
      config,
      vi.fn(
        async () =>
          new Response('private upstream details', {
            status: 401,
            headers: { 'x-correlation-id': 'req-1' },
          }),
      ),
    );
    await expect(denied('/executions', schema)).rejects.toMatchObject({
      status: 401,
      requestId: 'req-1',
    });
    const timedOut = createApiClient(
      config,
      vi.fn(async () => {
        throw new DOMException('Synthetic timeout', 'TimeoutError');
      }),
    );
    await expect(timedOut('/executions', schema)).rejects.toMatchObject({
      status: 503,
    });
    const transport = vi.fn<typeof fetch>(
      async () => new Response('{"ok":true}', { status: 201 }),
    );
    expect(
      (
        await createApiClient(config, transport)('/executions', schema, {
          method: 'POST',
          body: {},
        })
      ).created,
    ).toBe(true);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: { 'x-api-key': config.OPERATOR_API_KEY },
    });
  });
  it('refuses redirects before the operator API key reaches another origin', async () => {
    let redirectedRequests = 0;
    const target = createServer((_request, response) => {
      redirectedRequests++;
      response.end('{"ok":true}');
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const targetPort = (target.address() as AddressInfo).port;
    const upstream = createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${targetPort}/capture`,
      });
      response.end();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    try {
      const port = (upstream.address() as AddressInfo).port;
      const client = createApiClient({
        ...config,
        API_BASE_URL: `http://127.0.0.1:${port}`,
      });
      await expect(
        client('/executions', z.object({ ok: z.boolean() })),
      ).rejects.toMatchObject({ status: 503, code: 'unavailable' });
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          target.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
    }
  });
});
