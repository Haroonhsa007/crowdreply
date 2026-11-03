import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  ExtractionJobPayloadSchema,
  type ExtractionJobPayload,
} from '../contracts/extraction.js';
import type { ExtractionEnqueuer } from '../extraction/service.js';
import type { ExtractionRepository } from '../db/extraction-repository.js';
export function createExtractionQueue(
  connection: Redis,
  repository: ExtractionRepository,
) {
  const queue = new Queue<ExtractionJobPayload>('extraction', { connection });
  const enqueuer: ExtractionEnqueuer = {
    async enqueue(value) {
      const payload = ExtractionJobPayloadSchema.parse(value);
      const work = await repository.byVersion(payload);
      if (!work || !['pending', 'extracting'].includes(work.status)) return;
      const existing = await queue.getJob(work.id);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'completed' && state !== 'failed') return;
        await existing.remove();
      }
      await queue.add('extract', payload, {
        jobId: work.id,
        attempts: 1,
        delay: work.retryAt
          ? Math.max(0, Date.parse(work.retryAt) - Date.now())
          : 0,
        removeOnComplete: { age: 60, count: 1000 },
        removeOnFail: { age: 300, count: 1000 },
      });
    },
  };
  return { enqueuer, close: () => queue.close() };
}
