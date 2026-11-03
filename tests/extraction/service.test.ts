import { describe, expect, it, vi } from 'vitest';
import { createExtractionService } from '../../src/extraction/service.js';
import { processExtraction } from '../../src/workers/extraction-worker.js';
import { recoverExtractions } from '../../src/workers/extraction-recovery.js';
import { apiFixture } from '../api/fixture.js';
import { extractionFixture } from './storage-fixture.js';
import { assessmentRaw } from './fixtures.js';
function fixture() {
  const store = extractionFixture();
  const api = apiFixture();
  vi.spyOn(api.deps.repository, 'getById').mockResolvedValue(store.execution);
  const raw = vi
    .spyOn(api.deps.repository, 'getRawResponse')
    .mockResolvedValue(assessmentRaw);
  const enqueue = vi.fn(async (): Promise<void> => undefined);
  const deps = {
    repository: api.deps.repository,
    extractions: store.repository,
    logger: api.logger,
  };
  return {
    ...store,
    raw,
    enqueue,
    deps,
    service: createExtractionService({ ...deps, enqueuer: { enqueue } }),
  };
}
describe('separate extraction lifecycle', () => {
  it('creates new immutable versions for distinct reprocess keys and deduplicates repeated keys', async () => {
    const { execution, repository, service, deps } = fixture();
    await service.initial(execution.id);
    await processExtraction(
      { executionId: execution.id, extractorVersion: 'rules-v1-initial' },
      deps,
    );
    const initial = (await repository.detail(execution.id)).current;
    const first = await service.reprocess(execution.id, {
      idempotencyKey: 'request-one',
    });
    const repeat = await service.reprocess(execution.id, {
      idempotencyKey: 'request-one',
    });
    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.extraction.id).toBe(first.extraction.id);
    await processExtraction(
      {
        executionId: execution.id,
        extractorVersion: first.extraction.extractorVersion,
      },
      deps,
    );
    const next = await service.reprocess(execution.id, {
      idempotencyKey: 'request-two',
    });
    expect(next.extraction.id).not.toBe(first.extraction.id);
    const detail = await repository.detail(execution.id);
    expect(detail.history).toHaveLength(3);
    expect(detail.history.find((item) => item.id === initial?.id)).toEqual(
      initial,
    );
  });
  it('accepts work durably during enqueue outage and recovers it without another request', async () => {
    const { execution, service, repository, enqueue, storage } = fixture();
    enqueue.mockRejectedValueOnce(new Error('Synthetic transport outage'));
    const result = await service.reprocess(execution.id, {
      idempotencyKey: 'durable-request',
    });
    expect(result.created).toBe(true);
    expect(storage.extractions.rows).toHaveLength(1);
    expect(storage.executions.rows[0]?.extractionStatus).toBe('pending');
    await recoverExtractions(repository, service);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith({
      executionId: execution.id,
      extractorVersion: result.extraction.extractorVersion,
    });
  });
  it('bounds extraction retries and preserves the successful provider/raw response', async () => {
    const { execution, service, repository, deps, advance, storage, raw } =
      fixture();
    await service.initial(execution.id);
    const extract = vi.fn(() => {
      throw new Error('Synthetic extractor failure');
    });
    const payload = {
      executionId: execution.id,
      extractorVersion: 'rules-v1-initial',
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      await processExtraction(payload, { ...deps, extract });
      advance(5000);
    }
    expect(extract).toHaveBeenCalledTimes(3);
    await processExtraction(payload, { ...deps, extract });
    expect(extract).toHaveBeenCalledTimes(3);
    expect((await repository.detail(execution.id)).current?.status).toBe(
      'extraction_failed',
    );
    expect(storage.executions.rows[0]).toMatchObject({
      status: 'succeeded',
      rawResponseId: 'synthetic-raw',
    });
    expect(raw.mock.results.every((result) => result.type === 'return')).toBe(
      true,
    );
    expect(assessmentRaw.outputText).toContain('HubSpot CRM');
  });
  it('reports expired raw honestly and rejects reprocessing without creating another version', async () => {
    const { execution, service, repository, deps, raw } = fixture();
    raw.mockResolvedValue(null);
    await expect(
      service.reprocess(execution.id, { idempotencyKey: 'expired' }),
    ).rejects.toMatchObject({ status: 410 });
    expect((await repository.detail(execution.id)).history).toEqual([]);
    await service.initial(execution.id);
    await processExtraction(
      { executionId: execution.id, extractorVersion: 'rules-v1-initial' },
      deps,
    );
    expect((await repository.detail(execution.id)).current).toMatchObject({
      status: 'extraction_failed',
      error: { code: 'raw_unavailable' },
    });
  });
  it('accepts a durable request within a deadline when enqueue never settles', async () => {
    vi.useFakeTimers();
    try {
      const { execution, service, storage, enqueue, deps } = fixture();
      enqueue.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const warning = vi.spyOn(deps.logger, 'warn');
      let accepted: unknown;
      const pending = service
        .reprocess(execution.id, { idempotencyKey: 'unresolved-outage' })
        .then((value) => {
          accepted = value;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(storage.extractions.rows).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(accepted).toMatchObject({
        created: true,
        extraction: { status: 'pending' },
      });
      await pending;
      expect(warning).toHaveBeenCalledWith(
        { stage: 'extraction.enqueue_deferred' },
        'Durable extraction awaits queue recovery',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
