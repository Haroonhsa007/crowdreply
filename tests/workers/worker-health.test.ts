import { describe, expect, it, vi } from 'vitest';
import { workerReady } from '../../src/workers/worker-health.js';

describe('worker readiness', () => {
  const up = { mongo: async () => {}, redis: async () => {} };
  const ready = () => ({
    draining: false,
    recovered: true,
    isRunning: () => true,
  });
  it('requires successful recovery and all workers running', async () => {
    expect(await workerReady(ready(), up)).toBe(true);
    expect(await workerReady({ ...ready(), recovered: false }, up)).toBe(false);
    expect(await workerReady({ ...ready(), isRunning: () => false }, up)).toBe(
      false,
    );
  });
  it('reports dependency loss and recovery without leaking dependency errors', async () => {
    const redis = vi
      .fn()
      .mockRejectedValueOnce(new Error('placeholder-private-error'))
      .mockResolvedValue(undefined);
    expect(await workerReady(ready(), { ...up, redis })).toBe(false);
    expect(await workerReady(ready(), { ...up, redis })).toBe(true);
  });
  it('bounds hanging checks and reports draining even when pings complete', async () => {
    expect(
      await workerReady(
        ready(),
        { ...up, redis: () => new Promise(() => {}) },
        5,
      ),
    ).toBe(false);
    const state = ready();
    expect(
      await workerReady(state, {
        ...up,
        redis: async () => {
          state.draining = true;
        },
      }),
    ).toBe(false);
    expect(await workerReady(state, up)).toBe(false);
  });
});
