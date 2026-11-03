import type {
  ExecutionEnqueuer,
  ExecutionRepository,
} from '../contracts/index.js';

export async function recoverExecutions(
  repository: ExecutionRepository,
  enqueuer: ExecutionEnqueuer,
  now = new Date(),
): Promise<number> {
  // This single owner lookup is independent of paging, including terminal owners.
  let failures = 0;
  try {
    await repository.recoverBudgetGate?.(now);
  } catch {
    failures++;
  }
  const executions = await repository.listRecoverable(now, 100);
  let recovered = 0;
  for (const execution of executions) {
    try {
      await repository.touchRecovery?.(execution.id, now);
      const fence = {
        claimToken: execution.claimToken,
        leaseUntil: execution.leaseUntil,
      };
      if (await repository.reconcileCompletion?.(execution.id, fence)) continue;
      if (
        ['running', 'unknown_outcome'].includes(execution.status) &&
        execution.integration === 'live' &&
        (execution.claimAttemptRecorded ?? execution.attempts.length > 0)
      ) {
        await repository.markUnknownOutcome(execution.id, fence);
        continue;
      }
      if (execution.status === 'running')
        await repository.scheduleRetry(execution.id, now, 'timeout', fence);
      const current = await repository.getById(execution.id);
      if (!current || !['queued', 'retry_wait'].includes(current.status))
        continue;
      await enqueuer.enqueue({
        executionId: execution.id,
        executionKey: execution.executionKey,
      });
      recovered++;
    } catch {
      // Touch first so poison rows cannot block another provider's recovery.
      // Mongo retains eligible state; the next bounded pass retries the row.
      failures++;
      continue;
    }
  }
  if (failures)
    throw new Error(`Recovery incomplete: ${failures} operation(s) failed`);
  return recovered;
}
