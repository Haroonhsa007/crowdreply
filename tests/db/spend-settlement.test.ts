import { describe, expect, it, vi } from 'vitest';
import { repositoryFixture } from './fake-driver.js';
import { executionInput } from './fixtures.js';
import {
  LIVE_BUDGET_LEDGER_KEY,
  worstCaseReservation,
} from '../../src/db/spend-reservation.js';

describe('Mongo spend settlement through the in-memory driver', () => {
  it('upgrades null to a number once and never rewrites numeric amounts, including zero', async () => {
    const { repository } = repositoryFixture();
    const { execution } = await repository.createQueuedIfAbsent({
      ...executionInput,
      model: 'gpt-6-luna',
    });
    await repository.claim(execution.executionKey, 1000);
    await repository.recordAttempt(execution.id, {
      n: 1,
      integration: 'live',
      startedAt: new Date().toISOString(),
    });
    const row = {
      executionId: execution.id,
      idempotencyKey: `${execution.id}:provider:1`,
      stage: 'provider' as const,
      amountUsd: null,
    };
    await repository.recordSpend(row);
    expect(await repository.getSpendTotal()).toBeNull();
    await repository.recordSpend({ ...row, amountUsd: 0 });
    await repository.recordSpend({ ...row, amountUsd: 99 });
    await repository.recordSpend(row);
    expect(await repository.getSpendTotal()).toBe(0);
    await repository.recordSpend({
      ...row,
      idempotencyKey: 'another-charge',
      amountUsd: null,
    });
    await repository.recordSpend({
      ...row,
      idempotencyKey: 'another-charge',
      amountUsd: 0.05,
    });
    await repository.recordSpend({
      ...row,
      idempotencyKey: 'another-charge',
      amountUsd: 0.001,
    });
    expect(await repository.getSpendTotal()).toBe(0.05);
  });
  it('accounts unknown outcomes numerically without releasing another execution gate', async () => {
    const { repository, storage } = repositoryFixture();
    const { execution } = await repository.createQueuedIfAbsent({
      ...executionInput,
      model: 'gpt-6-luna',
    });
    await repository.claim(execution.executionKey, 1000);
    await repository.recordAttempt(execution.id, {
      n: 1,
      integration: 'live',
      startedAt: new Date().toISOString(),
      reservationUsd: 0.05,
    });
    await storage.spend.insertOne({
      idempotencyKey: LIVE_BUDGET_LEDGER_KEY,
      integration: 'internal',
      state: 'held',
      owner: 'another-execution',
    });
    await repository.markUnknownOutcome(execution.id);
    await repository.markUnknownOutcome(execution.id);
    expect(await repository.getSpendTotal()).toBe(
      worstCaseReservation('openai', 'gpt-6-luna'),
    );
    expect(
      storage.spend.rows.find(
        (row) => row.idempotencyKey === LIVE_BUDGET_LEDGER_KEY,
      )?.owner,
    ).toBe('another-execution');
  });
  it.each([
    null,
    undefined,
    'unknown',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
  ])(
    'fails closed for genuinely invalid/unknown stored amount %s',
    async (amountUsd) => {
      const { repository, storage } = repositoryFixture();
      await storage.spend.insertOne({
        idempotencyKey: 'invalid-fixture',
        integration: 'live',
        amountUsd,
      });
      expect(await repository.getSpendTotal()).toBeNull();
    },
  );
  it('uses the larger of the runtime reserve and researched estimate; unknown prices stay unknown', () => {
    vi.stubEnv('LIVE_CALL_RESERVE_USD', '0.25');
    try {
      expect(worstCaseReservation('openai', 'gpt-6-luna')).toBe(0.25);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(
      worstCaseReservation('gemini', 'gemini-3.6-flash', 0.001),
    ).toBeGreaterThan(0.001);
    expect(
      worstCaseReservation('openai', 'unknown-synthetic-model'),
    ).toBeNull();
  });
});
