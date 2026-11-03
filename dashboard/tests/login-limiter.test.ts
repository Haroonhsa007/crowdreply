import { describe, expect, it } from 'vitest';
import { loginLimiter } from '../src/lib/auth/credentials';

describe('sign-in cooldown feedback', () => {
  it('reports the actual remaining cooldown only after five failed attempts', () => {
    let now = 1000;
    const limiter = loginLimiter(() => now);
    for (let attempt = 0; attempt < 4; attempt++) limiter.failed();
    expect(limiter.permitted()).toBe(true);
    expect(limiter.remainingSeconds()).toBe(0);
    now += 1500;
    limiter.failed();
    expect(limiter.permitted()).toBe(false);
    expect(limiter.remainingSeconds()).toBe(299);
    now = 300999;
    expect(limiter.remainingSeconds()).toBe(1);
    now = 301000;
    expect(limiter.remainingSeconds()).toBe(0);
    expect(limiter.permitted()).toBe(true);
  });

  it('clears cooldown after successful authentication resets the limiter', () => {
    const limiter = loginLimiter(() => 1000);
    for (let attempt = 0; attempt < 5; attempt++) limiter.failed();
    expect(limiter.remainingSeconds()).toBe(300);
    limiter.reset();
    expect(limiter.permitted()).toBe(true);
    expect(limiter.remainingSeconds()).toBe(0);
  });
});
