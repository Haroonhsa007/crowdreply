import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  ProviderIdSchema,
  QueueJobPayloadSchema,
  type ExecutionEnqueuer,
  type ExecutionRepository,
  type ProviderId,
  type QueueJobPayload,
} from '../contracts/index.js';

export function createQueues(
  connection: Redis,
  repository: ExecutionRepository,
) {
  const queues = Object.fromEntries(
    ProviderIdSchema.options.map((provider) => [
      provider,
      new Queue<QueueJobPayload>(`provider-${provider}`, { connection }),
    ]),
  ) as Record<ProviderId, Queue<QueueJobPayload>>;
  const enqueuer: ExecutionEnqueuer = {
    async enqueue(value) {
      const payload = QueueJobPayloadSchema.parse(value);
      const execution = await repository.getById(payload.executionId);
      if (!execution || execution.executionKey !== payload.executionKey)
        throw new Error('Execution not found');
      if (!['queued', 'retry_wait'].includes(execution.status)) return;
      const queue = queues[execution.provider];
      const existing = await queue.getJob(payload.executionKey);
      if (existing) {
        const state = await existing.getState();
        if (state !== 'completed' && state !== 'failed') return;
        await existing.remove();
      }
      await queue.add('execute', payload, {
        jobId: payload.executionKey,
        attempts: 1,
        delay: execution.retryAt
          ? Math.max(0, Date.parse(execution.retryAt) - Date.now())
          : 0,
        removeOnComplete: { age: 60, count: 1000 },
        removeOnFail: { age: 300, count: 1000 },
      });
    },
  };
  return {
    queues,
    enqueuer,
    pause: (provider: ProviderId) => queues[provider].pause(),
    close: async () => {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
    },
  };
}
