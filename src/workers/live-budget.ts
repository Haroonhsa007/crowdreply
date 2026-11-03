import type { CollectionPort } from '../db/execution-repository.js';
import { LIVE_BUDGET_LEDGER_KEY } from '../db/spend-reservation.js';
import { randomUUID } from 'node:crypto';
import type { ClaimFence } from '../contracts/index.js';

export interface LiveBudgetGate {
  acquire(
    owner: string,
    fence?: ClaimFence,
  ): Promise<(() => Promise<void>) | null>;
}
/** One global Mongo gate serializes live spending across provider queues and processes.
 * Recovery never steals an active gate. It first accounts for an expired live
 * attempt conservatively, then releases only that execution's gate.
 */
export function createMongoBudgetGate(ledger: CollectionPort): LiveBudgetGate {
  const idempotencyKey = LIVE_BUDGET_LEDGER_KEY;
  return {
    async acquire(owner, fence) {
      const gateToken = randomUUID();
      try {
        await ledger.updateOne(
          { idempotencyKey },
          { $setOnInsert: { state: 'free', integration: 'internal' } },
          { upsert: true },
        );
      } catch (error) {
        if (!(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 11000
        ))
          throw error;
      }
      const row = await ledger.findOneAndUpdate(
        { idempotencyKey, state: 'free' },
        {
          $set: {
            state: 'held',
            owner,
            gateToken,
            ...(fence?.claimToken ? { claimToken: fence.claimToken } : {}),
          },
        },
        { returnDocument: 'after' },
      );
      if (!row) return null;
      return async () => {
        await ledger.updateOne(
          { idempotencyKey, state: 'held', owner, gateToken },
          {
            $set: { state: 'free' },
            $unset: { owner: '', claimToken: '', gateToken: '' },
          },
        );
      };
    },
  };
}
