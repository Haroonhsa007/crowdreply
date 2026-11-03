import { describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { createExtractionQueue } from '../../src/queue/extraction-queue.js';
import { createExtractionService } from '../../src/extraction/service.js';
import { apiFixture } from '../api/fixture.js';
import { extractionFixture } from './storage-fixture.js';
const { queue, QueueConstructor } = vi.hoisted(() => {
  const queue = {
    getJob: vi.fn(),
    add: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    queue,
    QueueConstructor: vi.fn(function () {
      return queue;
    }),
  };
});
vi.mock('bullmq', () => ({ Queue: QueueConstructor }));
describe('separate extraction transport and fair recovery', () => {
  it('uses its own queue, one transport attempt, durable identity, terminal-job replacement and shutdown', async () => {
    const { repository, execution } = extractionFixture();
    const requested = await repository.request(execution);
    const connection = new Redis({ lazyConnect: true });
    const transport = createExtractionQueue(connection, repository);
    const payload = {
      executionId: execution.id,
      extractorVersion: requested.extraction.extractorVersion,
    };
    try {
      expect(QueueConstructor).toHaveBeenCalledWith('extraction', {
        connection,
      });
      queue.getJob.mockResolvedValueOnce(undefined);
      await transport.enqueuer.enqueue(payload);
      expect(queue.add).toHaveBeenLastCalledWith(
        'extract',
        payload,
        expect.objectContaining({
          jobId: requested.extraction.id,
          attempts: 1,
        }),
      );
      const remove = vi.fn(async () => undefined);
      queue.getJob.mockResolvedValueOnce({
        getState: async () => 'waiting',
        remove,
      });
      await transport.enqueuer.enqueue(payload);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
      queue.getJob.mockResolvedValueOnce({
        getState: async () => 'completed',
        remove,
      });
      await transport.enqueuer.enqueue(payload);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(2);
      await transport.close();
      expect(queue.close).toHaveBeenCalledTimes(1);
    } finally {
      connection.disconnect();
    }
  });
  it('rotates bounded recovery batches so older pending work cannot starve later versions', async () => {
    const { repository, execution, advance } = extractionFixture();
    await repository.request(execution);
    advance(1);
    await repository.request(execution, 'rules-v1-reprocess-next');
    const api = apiFixture();
    const enqueue = vi.fn(async () => undefined);
    const service = createExtractionService({
      repository: api.deps.repository,
      extractions: repository,
      logger: api.logger,
      enqueuer: { enqueue },
    });
    const first = await repository.recover(1);
    expect(first[0]?.extractorVersion).toBe('rules-v1-initial');
    await service.dispatch(first[0]!);
    const next = await repository.recover(1);
    expect(next[0]?.extractorVersion).toBe('rules-v1-reprocess-next');
  });
});
