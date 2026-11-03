import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { foundationEnv } from '../foundation/fixtures.js';
import { apiFixture } from './fixture.js';
describe('authenticated API with in-memory dependencies', () => {
  it('requires auth without length hints and keeps health public', async () => {
    const { app } = apiFixture();
    for (const key of ['', 'wrong', 'x'.repeat(100)])
      expect(
        (await request(app).get('/executions').set('x-api-key', key)).status,
      ).toBe(401);
    expect((await request(app).get('/health')).status).toBe(200);
  });
  it('creates once, heals transport idempotently and validates list bounds', async () => {
    const { app, jobs } = apiFixture();
    const post = () =>
      request(app)
        .post('/executions')
        .set('x-api-key', foundationEnv.OPERATOR_API_KEY)
        .send({ questionText: 'Best CRM?' });
    const first = await post();
    const second = await post();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['x-execution-created']).toBe('false');
    expect(first.body.id).toBe(second.body.id);
    expect(jobs.size).toBe(1);
    expect(
      (
        await request(app)
          .get('/executions?limit=101')
          .set('x-api-key', foundationEnv.OPERATOR_API_KEY)
      ).status,
    ).toBe(400);
    const list = await request(app)
      .get('/executions?provider=openai&limit=1')
      .set('x-api-key', foundationEnv.OPERATOR_API_KEY);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/rawPayload|apiKey|"body"/);
    expect(
      (
        await request(app)
          .get(`/executions/${first.body.id}`)
          .set('x-api-key', foundationEnv.OPERATOR_API_KEY)
      ).body,
    ).not.toHaveProperty('raw');
  });
  it('sets/removes temporary keys without returning them and rejects Google/header injection', async () => {
    const { app, logs } = apiFixture();
    const fake = 'placeholder-user-provider-key';
    const set = await request(app)
      .put('/providers/openai/key')
      .set('x-api-key', foundationEnv.OPERATOR_API_KEY)
      .send({ provider: 'openai', apiKey: fake });
    expect(set.status).toBe(200);
    expect(set.body.keySource).toBe('user');
    expect(JSON.stringify(set.body) + logs()).not.toContain(fake);
    const remove = await request(app)
      .delete('/providers/openai/key')
      .set('x-api-key', foundationEnv.OPERATOR_API_KEY);
    expect(remove.body.mode).toBe('mock');
    for (const [provider, apiKey] of [
      ['google_ai', fake],
      ['openai', 'bad\nheader'],
    ]) {
      expect(
        (
          await request(app)
            .put(`/providers/${provider}/key`)
            .set('x-api-key', foundationEnv.OPERATOR_API_KEY)
            .send({ provider, apiKey })
        ).status,
      ).toBe(400);
    }
    const list = await request(app)
      .get('/providers')
      .set('x-api-key', foundationEnv.OPERATOR_API_KEY);
    expect(list.body.items).toHaveLength(5);
    expect(JSON.stringify(list.body)).not.toContain(fake);
  });
  it('exposes live spend only, safe errors and rate limits key writes', async () => {
    const { app } = apiFixture();
    const spend = await request(app)
      .get('/spend')
      .set('x-api-key', foundationEnv.OPERATOR_API_KEY);
    expect(spend.body).toEqual({ totalUsd: 0, capUsd: 2, remainingUsd: 2 });
    for (let i = 0; i < 10; i++)
      await request(app)
        .delete('/providers/openai/key')
        .set('x-api-key', foundationEnv.OPERATOR_API_KEY);
    expect(
      (
        await request(app)
          .delete('/providers/openai/key')
          .set('x-api-key', foundationEnv.OPERATOR_API_KEY)
      ).status,
    ).toBe(429);
  });
});
