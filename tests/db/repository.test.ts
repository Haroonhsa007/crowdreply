import { describe, expect, it } from 'vitest';
import { repositoryFixture } from './fake-driver.js';
import { executionInput, syntheticResult } from './fixtures.js';

describe('Mongo repository against a synthetic atomic driver', () => {
  it('concurrent duplicate creation and claims each have one winner', async () => {
    const { repository } = repositoryFixture();
    const results = await Promise.all([
      repository.createQueuedIfAbsent(executionInput),
      repository.createQueuedIfAbsent(executionInput),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]?.execution.id).toBe(results[1]?.execution.id);
    const key = results[0]!.execution.executionKey;
    expect(
      (
        await Promise.all([
          repository.claim(key, 1000),
          repository.claim(key, 1000),
        ])
      ).filter(Boolean),
    ).toHaveLength(1);
  });
  it('persists raw first, replays completion without duplicates and accounts spend idempotently', async () => {
    const { repository, storage } = repositoryFixture();
    const { execution } = await repository.createQueuedIfAbsent(executionInput);
    await repository.claim(execution.executionKey, 1000);
    await repository.recordAttempt(execution.id, {
      n: 1,
      integration: 'live',
      startedAt: syntheticResult.startedAt,
    });
    const raw = {
      executionId: execution.id,
      body: syntheticResult.rawPayload,
      outputText: syntheticResult.answerText,
      citations: [],
      providerResponseId: syntheticResult.requestId,
      createdAt: syntheticResult.completedAt,
    };
    expect(
      (await repository.saveRawAndComplete(execution.id, raw, syntheticResult))
        .status,
    ).toBe('succeeded');
    await repository.saveRawAndComplete(execution.id, raw, syntheticResult);
    expect(storage.raw.rows).toHaveLength(1);
    expect((await repository.getRawResponse(execution.id))?.body).toEqual({
      synthetic: true,
    });
    const spend = {
      executionId: execution.id,
      idempotencyKey: 'attempt-1',
      stage: 'provider' as const,
      amountUsd: 0.011,
    };
    await repository.recordSpend(spend);
    await repository.recordSpend(spend);
    expect(await repository.getSpendTotal()).toBe(0.011);
    await repository.recordSpend({
      ...spend,
      idempotencyKey: 'unknown',
      amountUsd: null,
    });
    expect(await repository.getSpendTotal()).toBeNull();
  });
  it('recovery excludes terminal work and never blindly reclaims expired live attempts', async () => {
    let time = new Date('2026-11-02T00:00:00Z');
    const { repository } = repositoryFixture(() => time);
    const { execution } = await repository.createQueuedIfAbsent(executionInput);
    await repository.claim(execution.executionKey, 1);
    await repository.recordAttempt(execution.id, {
      n: 1,
      integration: 'live',
      startedAt: time.toISOString(),
    });
    time = new Date(time.getTime() + 10);
    expect(await repository.claim(execution.executionKey, 100)).toBeNull();
    expect(await repository.listRecoverable(time, 100)).toHaveLength(1);
    await repository.markUnknownOutcome(execution.id);
    expect(await repository.listRecoverable(time, 100)).toHaveLength(0);
    expect(await repository.getSpendTotal()).toBeNull();
  });
  it('bounds lists, supports retry dates and does not count mock spend', async () => {
    const { repository } = repositoryFixture();
    const { execution } = await repository.createQueuedIfAbsent(executionInput);
    await expect(repository.listRecent({ limit: 101 })).rejects.toThrow(
      'Invalid page limit',
    );
    await repository.claim(execution.executionKey, 1000);
    await repository.recordAttempt(execution.id, {
      n: 1,
      integration: 'mock',
      startedAt: new Date().toISOString(),
    });
    await repository.recordSpend({
      executionId: execution.id,
      idempotencyKey: 'mock',
      stage: 'provider',
      amountUsd: 100,
    });
    expect(await repository.getSpendTotal()).toBe(0);
    await repository.scheduleRetry(
      execution.id,
      new Date('2026-11-02T00:00:00Z'),
      'timeout',
    );
    expect(
      (await repository.listRecent({ limit: 1, status: 'retry_wait' }))[0]
        ?.lastErrorCategory,
    ).toBe('timeout');
  });
});
