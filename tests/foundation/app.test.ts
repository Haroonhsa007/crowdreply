import { foundationEnv } from './fixtures.js';
import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';

function setup(
  checks = {
    mongo: async (_signal: AbortSignal) => {},
    redis: async (_signal: AbortSignal) => {},
  },
) {
  let logs = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const logger = createLogger(
    loadConfig({
      ...foundationEnv,
      MONGODB_URI: 'mongodb://localhost:27017/test',
      REDIS_URL: 'redis://localhost:6379',
      OPERATOR_API_KEY: 'placeholder-operator-test-only',
    }),
    destination,
  );
  const app = createApp({
    logger,
    checks,
    registerRoutes(app) {
      app.get('/explode', () => {
        throw new Error('fixture-sensitive-stack-and-connection-string');
      });
      app.post('/echo', (_req, res) => {
        res.json({ status: 'ok' });
      });
    },
  });
  return { app, logs: () => logs };
}

describe('foundation HTTP boundaries', () => {
  it('liveness returns 200 without touching dependencies or advertising Express', async () => {
    const mongo = vi.fn();
    const redis = vi.fn();
    const { app } = setup({ mongo, redis });
    const result = await request(app).get('/health');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok' });
    expect(result.headers['x-powered-by']).toBeUndefined();
    expect(mongo).not.toHaveBeenCalled();
    expect(redis).not.toHaveBeenCalled();
  });
  it('reuses correlation ID and includes request start/finish duration logs', async () => {
    const { app, logs } = setup();
    const result = await request(app)
      .get('/health')
      .set('x-correlation-id', 'demo-correlation-1');
    expect(result.headers['x-correlation-id']).toBe('demo-correlation-1');
    const entries = logs()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      event: 'request.start',
      correlationId: 'demo-correlation-1',
    });
    expect(entries[1]).toMatchObject({
      event: 'request.finish',
      correlationId: 'demo-correlation-1',
      statusCode: 200,
    });
    expect(entries[1].durationMs).toBeGreaterThanOrEqual(0);
  });
  it('generates IDs for absent or unsafe incoming values', async () => {
    const { app } = setup();
    const a = await request(app).get('/health');
    const b = await request(app)
      .get('/health')
      .set('x-correlation-id', '<unsafe>');
    expect(a.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(b.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(a.headers['x-correlation-id']).not.toBe(
      b.headers['x-correlation-id'],
    );
  });
  it('readiness is 200 when both fake dependencies are up', async () => {
    const { app } = setup();
    const result = await request(app).get('/health/ready');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'ready',
      dependencies: { mongo: { status: 'up' }, redis: { status: 'up' } },
    });
  });
  it('readiness is 503 when one fake dependency is down without leaking its error', async () => {
    const { app, logs } = setup({
      mongo: async () => {
        throw new Error('mongodb://fixture-user:fixture-password@localhost');
      },
      redis: async () => {},
    });
    const result = await request(app).get('/health/ready');
    expect(result.status).toBe(503);
    expect(result.body.dependencies.mongo).toEqual({
      status: 'down',
      reason: 'Dependency unavailable',
    });
    expect(result.body.dependencies.redis.status).toBe('up');
    expect(JSON.stringify(result.body) + logs()).not.toContain(
      'fixture-password',
    );
  });
  it('bounds both hanging checks with individual 1-second abort deadlines', async () => {
    const signals: AbortSignal[] = [];
    const hanging = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>(() => {});
    };
    const { app } = setup({ mongo: hanging, redis: hanging });
    const result = await request(app).get('/health/ready');
    expect(result.status).toBe(503);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.body.dependencies.mongo.reason).toBe(
      'Health check timed out',
    );
    expect(result.body.dependencies.redis.reason).toBe(
      'Health check timed out',
    );
  });
  it('returns generic 404 and 500 JSON without stacks or error content', async () => {
    const { app, logs } = setup();
    const missing = await request(app).get('/absent');
    const failure = await request(app).get('/explode');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Not found' });
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(failure.body) + logs()).not.toContain(
      'fixture-sensitive-stack-and-connection-string',
    );
  });
  it('enforces JSON limit, rejects malformed JSON and does not log bodies/query strings', async () => {
    const { app, logs } = setup();
    expect(
      (
        await request(app)
          .post('/echo')
          .send({ text: 'x'.repeat(101 * 1024) })
      ).status,
    ).toBe(413);
    expect(
      (
        await request(app)
          .post('/echo')
          .set('Content-Type', 'application/json')
          .send('{invalid')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/echo?apiKey=fixture-query-value')
          .send({ text: 'fixture-body-value' })
      ).status,
    ).toBe(200);
    expect(logs()).not.toContain('fixture-query-value');
    expect(logs()).not.toContain('fixture-body-value');
  });
});
