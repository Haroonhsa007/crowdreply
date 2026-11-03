import { expect, it, vi } from 'vitest';
import { recoverExecutions } from '../../src/workers/recovery.js';
import { repositoryFixture } from '../db/fake-driver.js';
import { executionInput } from '../db/fixtures.js';
it('recovery repeatedly sends the stable execution identity to an idempotent transport', async () => {
  const { repository } = repositoryFixture();
  const { execution } = await repository.createQueuedIfAbsent(executionInput);
  const unique = new Set<string>();
  const enqueue = vi.fn(async (payload: { executionKey: string }) => {
    unique.add(payload.executionKey);
  });
  await recoverExecutions(repository, { enqueue });
  await recoverExecutions(repository, { enqueue });
  expect(unique).toEqual(new Set([execution.executionKey]));
});
