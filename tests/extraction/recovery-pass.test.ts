import { describe, expect, it, vi } from 'vitest';
import { runRecoveryPass } from '../../src/workers/recovery-pass.js';
import { recoverExtractions } from '../../src/workers/extraction-recovery.js';
import { processExtraction } from '../../src/workers/extraction-worker.js';
import { createExtractionService } from '../../src/extraction/service.js';
import { workerReady } from '../../src/workers/worker-health.js';
import { ExecutionSchema } from '../../src/contracts/index.js';
import { apiFixture } from '../api/fixture.js';
import { extractionFixture } from './storage-fixture.js';
import { assessmentRaw } from './fixtures.js';
describe('independent recovery phases', () => {
  it('keeps extraction progressing through repeated provider rejection, reports unready, and omits error details', async () => {
    const store = extractionFixture();
    const api = apiFixture();
    vi.spyOn(api.deps.repository, 'getById').mockImplementation(async (id) => {
      const row = store.storage.executions.rows.find((item) => item.id === id);
      return row ? ExecutionSchema.parse(row) : null;
    });
    vi.spyOn(api.deps.repository, 'getRawResponse').mockImplementation(
      async (id) => ({ ...assessmentRaw, executionId: id }),
    );
    const deps = {
      repository: api.deps.repository,
      extractions: store.repository,
      logger: api.logger,
    };
    const service = createExtractionService({
      ...deps,
      enqueuer: { enqueue: (payload) => processExtraction(payload, deps) },
    });
    const provider = vi.fn(async () => {
      throw new Error('placeholder-sensitive-provider-details');
    });
    const extraction = vi.fn(() =>
      recoverExtractions(store.repository, service),
    );
    for (let iteration = 0; iteration < 3; iteration++) {
      if (iteration)
        store.storage.executions.rows.push({
          ...store.execution,
          id: `synthetic-extraction-${iteration}`,
        });
      const recovered = await runRecoveryPass(
        { provider, extraction },
        api.logger,
      );
      expect(recovered).toBe(false);
      const id = iteration
        ? `synthetic-extraction-${iteration}`
        : store.execution.id;
      expect((await store.repository.detail(id)).current?.status).toBe(
        'extracted',
      );
      expect(
        await workerReady(
          { draining: false, recovered, isRunning: () => true },
          { mongo: async () => undefined, redis: async () => undefined },
        ),
      ).toBe(false);
    }
    expect(provider).toHaveBeenCalledTimes(3);
    expect(extraction).toHaveBeenCalledTimes(3);
    expect(api.logs()).toContain('provider.recovery_failed');
    expect(api.logs()).not.toContain('placeholder-sensitive-provider-details');
  });
  it('reports each failed phase independently and succeeds only when both phases succeed', async () => {
    const api = apiFixture();
    const provider = vi.fn(async () => undefined);
    const extraction = vi.fn(async () => {
      throw new Error('placeholder-sensitive-extraction-details');
    });
    expect(await runRecoveryPass({ provider, extraction }, api.logger)).toBe(
      false,
    );
    expect(api.logs()).toContain('extraction.recovery_failed');
    expect(api.logs()).not.toContain(
      'placeholder-sensitive-extraction-details',
    );
    expect(
      await runRecoveryPass(
        { provider, extraction: async () => undefined },
        api.logger,
      ),
    ).toBe(true);
  });
});
