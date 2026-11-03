import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { createDatabase } from '../../../src/db/connection.js';
import {
  createExecutionRepository,
  mongoStorage,
} from '../../../src/db/execution-repository.js';
import { executionInput, syntheticResult } from '../fixtures.js';
import { recoverExecutions } from '../../../src/workers/recovery.js';
import { randomUUID } from 'node:crypto';

function isolatedDatabase() {
  const config = loadConfig();
  const uri = new URL(config.MONGODB_URI);
  uri.pathname = `/crowdreply_test_${randomUUID().replaceAll('-', '')}`;
  return createDatabase({ ...config, MONGODB_URI: uri.toString() });
}

describe.skipIf(
  process.env.RUN_INTEGRATION !== '1' || !process.env.MONGODB_URI,
)('real Mongo integration (opt-in)', () => {
  it('reconciles staged raw and settlement on actual Mongo without a provider replay', async () => {
    const database = isolatedDatabase();
    let now = Date.now();
    try {
      await database.ensureIndexes();
      const repository = createExecutionRepository(
        mongoStorage(database.getDb()),
        () => new Date(now),
      );
      const { execution } = await repository.createQueuedIfAbsent({
        ...executionInput,
        questionId: `completion-integration-${now}`,
        model: 'gpt-6-luna',
      });
      const claim = (await repository.claim(execution.executionKey, 1))!;
      const fence = { claimToken: claim.claimToken };
      await repository.recordAttempt(
        execution.id,
        {
          n: 1,
          integration: 'live',
          startedAt: new Date(now).toISOString(),
          reservationUsd: 0.05,
        },
        fence,
      );
      await repository.recordSpend({
        executionId: execution.id,
        idempotencyKey: `${execution.id}:provider:1`,
        stage: 'provider',
        amountUsd: null,
      });
      await repository.stageProviderResult!(
        execution.id,
        {
          executionId: execution.id,
          body: syntheticResult.rawPayload,
          outputText: syntheticResult.answerText,
          citations: [],
          providerResponseId: null,
          createdAt: new Date(now).toISOString(),
        },
        syntheticResult,
        syntheticResult.cost.totalUsd,
        fence,
      );
      now += 10;
      let replayed = false;
      await recoverExecutions(
        repository,
        {
          enqueue: async (payload) => {
            if (payload.executionId === execution.id) replayed = true;
          },
        },
        new Date(now),
      );
      expect(replayed).toBe(false);
      expect((await repository.getById(execution.id))?.status).toBe(
        'succeeded',
      );
      expect((await repository.getRawResponse(execution.id))?.outputText).toBe(
        syntheticResult.answerText,
      );
      const charge = await database
        .getDb()
        .collection('spend_ledger')
        .findOne({ idempotencyKey: `${execution.id}:provider:1` });
      expect(charge?.amountUsd).toBe(syntheticResult.cost.totalUsd);
    } finally {
      await database.getDb().dropDatabase();
      await database.close();
    }
  });
  it('uses actual unique indexes for concurrent creation and claims', async () => {
    const database = isolatedDatabase();
    try {
      await database.ensureIndexes();
      const repository = createExecutionRepository(
        mongoStorage(database.getDb()),
      );
      const input = {
        ...executionInput,
        questionId: `integration-${Date.now()}`,
      };
      const results = await Promise.all([
        repository.createQueuedIfAbsent(input),
        repository.createQueuedIfAbsent(input),
      ]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      const indexes = await database.getDb().collection('executions').indexes();
      expect(indexes.some((index) => index.key.id === 1 && index.unique)).toBe(
        true,
      );
      const plan = await database
        .getDb()
        .collection('executions')
        .find({ id: results[0]!.execution.id })
        .explain('executionStats');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
      expect(plan.executionStats.totalDocsExamined).toBe(1);
      expect(
        (
          await Promise.all(
            results.map((result) =>
              repository.claim(result.execution.executionKey, 1000),
            ),
          )
        ).filter(Boolean),
      ).toHaveLength(1);
    } finally {
      await database.getDb().dropDatabase();
      await database.close();
    }
  });
});
