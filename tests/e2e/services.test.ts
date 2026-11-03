import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createRuntime } from '../../src/server.js';
import { createApp } from '../../src/app.js';
import { registerApiRoutes } from '../../src/api/routes.js';
import { createProviderAdapters } from '../../src/providers/index.js';
import { createProviderWorkers } from '../../src/workers/provider-worker.js';
import type { ProviderKeyResolver } from '../../src/contracts/index.js';

describe.skipIf(
  process.env.RUN_E2E !== '1' ||
    !process.env.MONGODB_URI ||
    !process.env.REDIS_URL,
)('real Mongo/Redis E2E (explicit opt-in, providers still mocked)', () => {
  it('processes an authenticated API submission through real BullMQ and Mongo raw persistence', async () => {
    const runtime = await createRuntime();
    const resolver: ProviderKeyResolver = {
      resolve: async (provider) => ({
        provider,
        mode: 'mock',
        keySource: 'none',
      }),
    };
    const workers = createProviderWorkers(runtime.transport, {
      config: runtime.config,
      logger: runtime.logger,
      repository: runtime.repository,
      resolver,
      adapters: createProviderAdapters({ config: runtime.config, resolver }),
      budgetGate: runtime.budgetGate,
      pause: runtime.queue.pause,
    });
    try {
      const app = createApp({
        logger: runtime.logger,
        checks: runtime.checks,
        registerRoutes: (app) =>
          registerApiRoutes(app, {
            config: runtime.config,
            repository: runtime.repository,
            resolver,
            keyStore: runtime.keyStore,
            enqueuer: runtime.queue.enqueuer,
          }),
      });
      const response = await request(app)
        .post('/executions')
        .set('x-api-key', runtime.config.OPERATOR_API_KEY)
        .send({ questionText: 'Integration CRM ' + randomUUID() });
      expect(response.status).toBe(201);
      let execution = await runtime.repository.getById(response.body.id);
      for (
        let attempt = 0;
        attempt < 100 && execution?.status !== 'succeeded';
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        execution = await runtime.repository.getById(response.body.id);
      }
      expect(execution).toMatchObject({
        status: 'succeeded',
        integration: 'mock',
      });
      expect(
        (await runtime.repository.getRawResponse(response.body.id))?.body,
      ).toHaveProperty('mock', true);
    } finally {
      await workers.close();
      await runtime.close();
    }
  }, 15000);
});
