import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { apiFixture } from '../api/fixture.js';
import { foundationEnv } from '../foundation/fixtures.js';
import { createProviderAdapters } from '../../src/providers/index.js';
import {
  processExecution,
  type WorkerDependencies,
} from '../../src/workers/provider-worker.js';
import { createMongoBudgetGate } from '../../src/workers/live-budget.js';
import { ProviderError, ProviderIdSchema } from '../../src/contracts/index.js';
import { synthetic } from '../providers/fixtures.js';

function worker(
  fixture: ReturnType<typeof apiFixture>,
  transport: typeof fetch = vi.fn(),
  clock = Date.now,
): WorkerDependencies {
  const { config, repository, resolver } = fixture.deps;
  return {
    config,
    repository,
    resolver,
    adapters: createProviderAdapters({ config, resolver, fetch: transport }),
    logger: fixture.logger,
    budgetGate: createMongoBudgetGate(fixture.storage.spend),
    // Deterministic synthetic responses only; production admission has no proven bound.
    liveBudgetBound: () => 0.05,
    clock,
    random: () => 0.5,
    schedule: async (payload) => {
      fixture.jobs.set(payload.executionKey, payload);
    },
    pause: vi.fn(),
  };
}
async function drain(
  fixture: ReturnType<typeof apiFixture>,
  deps: WorkerDependencies,
) {
  const jobs = [...fixture.jobs.values()];
  fixture.jobs.clear();
  for (const payload of jobs) await processExecution(payload, deps);
}
const auth = foundationEnv.OPERATOR_API_KEY;
describe('end-to-end platform, in process with synthetic data only', () => {
  it('submits all five providers, completes as Mock, preserves raw, lists/detail labels and spends nothing', async () => {
    const fixture = apiFixture();
    const transport = vi.fn();
    const deps = worker(fixture, transport);
    const ids: string[] = [];
    for (const provider of ProviderIdSchema.options) {
      const response = await request(fixture.app)
        .post('/executions')
        .set('x-api-key', auth)
        .send({ questionText: 'Best CRM for a small agency?', provider });
      expect(response.status).toBe(201);
      ids.push(response.body.id);
    }
    await drain(fixture, deps);
    expect(transport).not.toHaveBeenCalled();
    expect(fixture.storage.raw.rows).toHaveLength(5);
    const list = await request(fixture.app)
      .get('/executions')
      .set('x-api-key', auth);
    expect(list.body.items).toHaveLength(5);
    for (const id of ids) {
      const execution = await fixture.deps.repository.getById(id);
      expect(execution).toMatchObject({
        status: 'succeeded',
        integration: 'mock',
        usage: { inputTokens: null, outputTokens: null, toolCalls: null },
        cost: { totalUsd: 0 },
      });
      expect(execution?.attempts[0]?.integration).toBe('mock');
      expect(
        (await fixture.deps.repository.getRawResponse(id))?.body,
      ).toHaveProperty('mock', true);
      const detail = await request(fixture.app)
        .get(`/executions/${id}?raw=1`)
        .set('x-api-key', auth);
      expect(detail.body.integration).toBe('mock');
      expect(detail.body.raw.outputText).toContain('Mock answer');
      expect(JSON.stringify(detail.body)).not.toMatch(
        /"rawPayload"|"body"|"apiKey"/,
      );
    }
    expect(
      (await request(fixture.app).get('/spend').set('x-api-key', auth)).body
        .totalUsd,
    ).toBe(0);
    expect(await fixture.deps.repository.getSpendTotal()).toBe(0);
  });
  it('uses a synthetic live response with an env key, prefers a temporary user key and expires back to env', async () => {
    let now = Date.now();
    const envKey = 'placeholder-env-openai-key';
    const userKey = 'placeholder-user-openai-key';
    const fixture = apiFixture(() => now, { OPENAI_API_KEY: envKey });
    const seen: string[] = [];
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).not.toContain(envKey);
      expect(String(url)).not.toContain(userKey);
      seen.push(new Headers(init?.headers).get('Authorization') ?? '');
      return new Response(JSON.stringify(synthetic.openai), { status: 200 });
    });
    const deps = worker(fixture, transport, () => now);
    const submit = async () => {
      const response = await request(fixture.app)
        .post('/executions')
        .set('x-api-key', auth)
        .send({
          questionText: 'Best CRM for a startup?',
          provider: 'openai',
          force: true,
        });
      expect(response.status).toBe(201);
      await drain(fixture, deps);
      const detail = await request(fixture.app)
        .get(`/executions/${response.body.id}?raw=1`)
        .set('x-api-key', auth);
      expect(detail.body).toMatchObject({
        integration: 'live',
        status: 'succeeded',
      });
      expect(JSON.stringify(detail.body) + fixture.logs()).not.toContain(
        envKey,
      );
      expect(JSON.stringify(detail.body) + fixture.logs()).not.toContain(
        userKey,
      );
    };
    await submit();
    const saved = await request(fixture.app)
      .put('/providers/openai/key')
      .set('x-api-key', auth)
      .send({ provider: 'openai', apiKey: userKey });
    expect(saved.body.keySource).toBe('user');
    expect(JSON.stringify(saved.body)).not.toContain(userKey);
    await submit();
    now += 3600001;
    await submit();
    expect(seen).toEqual([
      `Bearer ${envKey}`,
      `Bearer ${userKey}`,
      `Bearer ${envKey}`,
    ]);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(await fixture.deps.repository.getSpendTotal()).toBeGreaterThan(0);
    const statuses = await request(fixture.app)
      .get('/providers')
      .set('x-api-key', auth);
    expect(
      statuses.body.items.find(
        (item: { provider: string }) => item.provider === 'openai',
      ).keySource,
    ).toBe('env');
    expect(JSON.stringify(statuses.body) + fixture.logs()).not.toContain(
      userKey,
    );
  });
  it('duplicates produce one execution and call; later extraction failure cannot repeat the provider', async () => {
    const fixture = apiFixture();
    const deps = worker(fixture);
    const execute = vi.spyOn(deps.adapters.openai, 'executeResolved');
    const submit = () =>
      request(fixture.app)
        .post('/executions')
        .set('x-api-key', auth)
        .send({ questionText: 'Best CRM?' });
    const first = await submit();
    const second = await submit();
    expect(second.body.id).toBe(first.body.id);
    expect(fixture.jobs.size).toBe(1);
    await drain(fixture, deps);
    const stored = fixture.storage.executions.rows.find(
      (row) => row.id === first.body.id,
    )!;
    stored.extractionStatus = 'extraction_failed';
    await processExecution(
      { executionId: first.body.id, executionKey: first.body.executionKey },
      deps,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fixture.storage.raw.rows).toHaveLength(1);
    expect((await fixture.deps.repository.getById(first.body.id))?.status).toBe(
      'succeeded',
    );
  });
  it('retries a transient mock failure, records permanent failure and refuses live spending while mock continues', async () => {
    let now = Date.now();
    const fixture = apiFixture(() => now);
    const deps = worker(fixture, vi.fn(), () => now);
    const original = deps.adapters.openai.executeResolved;
    vi.spyOn(deps.adapters.openai, 'executeResolved')
      .mockRejectedValueOnce(
        new ProviderError({
          category: 'server',
          retryable: true,
          message: 'Synthetic transient failure',
        }),
      )
      .mockImplementation(original);
    const first = await request(fixture.app)
      .post('/executions')
      .set('x-api-key', auth)
      .send({ questionText: 'Retry CRM?' });
    await drain(fixture, deps);
    expect((await fixture.deps.repository.getById(first.body.id))?.status).toBe(
      'retry_wait',
    );
    now += 3000;
    await drain(fixture, deps);
    expect((await fixture.deps.repository.getById(first.body.id))?.status).toBe(
      'succeeded',
    );
    vi.spyOn(deps.adapters.gemini, 'executeResolved').mockRejectedValue(
      new ProviderError({
        category: 'invalid_request',
        retryable: false,
        message: 'Synthetic permanent failure',
      }),
    );
    const bad = await request(fixture.app)
      .post('/executions')
      .set('x-api-key', auth)
      .send({ questionText: 'Failure CRM?', provider: 'gemini' });
    await drain(fixture, deps);
    expect((await fixture.deps.repository.getById(bad.body.id))?.status).toBe(
      'dead',
    );
    const capped = apiFixture(() => now, {
      OPENAI_API_KEY: 'placeholder-env-openai-key',
    });
    const network = vi.fn();
    const cappedDeps = worker(capped, network, () => now);
    vi.spyOn(capped.deps.repository, 'getSpendTotal').mockResolvedValue(1.99);
    for (const provider of ['openai', 'google_ai'])
      await request(capped.app)
        .post('/executions')
        .set('x-api-key', auth)
        .send({ questionText: 'Budget CRM?', provider });
    await drain(capped, cappedDeps);
    expect(network).not.toHaveBeenCalled();
    const records = await capped.deps.repository.listRecent({ limit: 10 });
    expect(records.find((item) => item.provider === 'openai')?.status).toBe(
      'dead',
    );
    expect(records.find((item) => item.provider === 'google_ai')).toMatchObject(
      { status: 'succeeded', integration: 'mock' },
    );
  });
});
