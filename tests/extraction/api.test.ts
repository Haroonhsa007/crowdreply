import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { registerApiRoutes } from '../../src/api/routes.js';
import { createExtractionService } from '../../src/extraction/service.js';
import { processExtraction } from '../../src/workers/extraction-worker.js';
import { apiFixture } from '../api/fixture.js';
import { extractionFixture } from './storage-fixture.js';
import { assessmentRaw } from './fixtures.js';
function fixture() {
  const store = extractionFixture();
  const api = apiFixture();
  vi.spyOn(api.deps.repository, 'getById').mockImplementation(async (id) =>
    id === store.execution.id ? store.execution : null,
  );
  vi.spyOn(api.deps.repository, 'getRawResponse').mockResolvedValue(
    assessmentRaw,
  );
  const extractionService = createExtractionService({
    repository: api.deps.repository,
    extractions: store.repository,
    enqueuer: { enqueue: vi.fn(async () => undefined) },
    logger: api.logger,
  });
  const app = createApp({
    logger: api.logger,
    checks: { mongo: async () => undefined, redis: async () => undefined },
    registerRoutes: (app) =>
      registerApiRoutes(app, {
        ...api.deps,
        extractions: store.repository,
        extractionService,
      }),
  });
  return {
    ...store,
    api,
    app,
    extractionService,
    auth: api.deps.config.OPERATOR_API_KEY,
  };
}
describe('extraction API boundary', () => {
  it('authenticates every extraction and visibility route', async () => {
    const { app } = fixture();
    expect(
      (await request(app).get('/executions/synthetic-extraction/extraction'))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/executions/synthetic-extraction/extraction/reprocess')
          .send({ idempotencyKey: 'one' })
      ).status,
    ).toBe(401);
    expect((await request(app).get('/visibility')).status).toBe(401);
  });
  it('accepts idempotent reprocessing, returns bounded history/detail summary, and preserves provenance', async () => {
    const { app, auth, execution, api, repository } = fixture();
    const route = `/executions/${execution.id}/extraction/reprocess`;
    const first = await request(app)
      .post(route)
      .set('x-api-key', auth)
      .send({ idempotencyKey: 'one' });
    expect(first.status).toBe(202);
    const repeat = await request(app)
      .post(route)
      .set('x-api-key', auth)
      .send({ idempotencyKey: 'one' });
    expect(repeat.status).toBe(200);
    expect(repeat.body.extraction.id).toBe(first.body.extraction.id);
    await processExtraction(
      {
        executionId: execution.id,
        extractorVersion: first.body.extraction.extractorVersion,
      },
      {
        repository: api.deps.repository,
        extractions: repository,
        logger: api.logger,
      },
    );
    const detail = await request(app)
      .get(`/executions/${execution.id}/extraction`)
      .set('x-api-key', auth);
    expect(detail.body).toMatchObject({
      current: { status: 'extracted', integration: 'mock' },
      historyLimit: 20,
    });
    expect(detail.body.history).toHaveLength(1);
    expect(detail.body.current.mentions[0]).toMatchObject({
      brand: 'HubSpot',
      position: 1,
    });
    const executionDetail = await request(app)
      .get(`/executions/${execution.id}`)
      .set('x-api-key', auth);
    expect(executionDetail.body.extraction).toMatchObject({
      id: first.body.extraction.id,
      status: 'extracted',
      method: 'rule_based',
    });
    expect(JSON.stringify(detail.body)).not.toContain(auth);
  });
  it('strictly validates true UTC dates, bounded ranges and literal boolean query values', async () => {
    const { app, auth, repository } = fixture();
    const visibility = vi.spyOn(repository, 'visibility');
    for (const query of [
      'includeMock=1',
      'includeMock=',
      'from=2026-02-30&to=2026-03-01',
      'from=2025-01-01&to=2026-11-02',
      'from=2026-11-03&to=2026-11-02',
      'from=2026-11-01T00:00:00Z',
      'unexpected=true',
    ])
      expect(
        (
          await request(app)
            .get('/visibility?' + query)
            .set('x-api-key', auth)
        ).status,
      ).toBe(400);
    expect(visibility).not.toHaveBeenCalled();
    const result = await request(app)
      .get('/visibility?from=2026-11-01&to=2026-11-02')
      .set('x-api-key', auth);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      includeMock: false,
      includesMock: false,
      executionCounts: { mock: 0 },
      items: [],
    });
    expect(visibility).toHaveBeenLastCalledWith({
      from: '2026-11-01',
      to: '2026-11-02',
      includeMock: false,
    });
    expect(
      (
        await request(app)
          .get('/visibility?includeMock=true&provider=google_ai')
          .set('x-api-key', auth)
      ).status,
    ).toBe(200);
    expect(visibility).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'google_ai', includeMock: true }),
    );
  });
  it('rejects invalid reprocess requests and unsuccessful provider executions', async () => {
    const { app, auth, execution, api } = fixture();
    const route = `/executions/${execution.id}/extraction/reprocess`;
    expect(
      (await request(app).post(route).set('x-api-key', auth).send({})).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(route)
          .set('x-api-key', auth)
          .send({ idempotencyKey: 'a'.repeat(129) })
      ).status,
    ).toBe(400);
    vi.spyOn(api.deps.repository, 'getById').mockResolvedValue({
      ...execution,
      status: 'queued',
    });
    expect(
      (
        await request(app)
          .post(route)
          .set('x-api-key', auth)
          .send({ idempotencyKey: 'one' })
      ).status,
    ).toBe(409);
  });
});
