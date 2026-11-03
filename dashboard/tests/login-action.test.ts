import { describe, expect, it, vi } from 'vitest';

const { setCookie, redirect } = vi.hoisted(() => ({
  setCookie: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('fixture redirect');
  }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: setCookie }) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('../src/lib/env', () => ({
  env: () => ({
    OPERATOR_USERNAME: 'fixture-operator',
    OPERATOR_PASSWORD: 'placeholder-password',
    SESSION_SECRET: 'placeholder-session-secret',
    NODE_ENV: 'production',
  }),
}));
vi.mock('../src/lib/auth/session', () => ({
  SESSION_COOKIE: 'fixture-session',
  SESSION_SECONDS: 3600,
  signSession: async () => 'placeholder-signed-session',
}));

const form = (password: string) => {
  const value = new FormData();
  value.set('username', 'fixture-operator');
  value.set('password', password);
  value.set('next', '/executions');
  return value;
};

describe('sign-in server enforcement', () => {
  it('returns a cooldown on the fifth failure, blocks even valid credentials until expiry, then preserves secure session behavior', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.resetModules();
    const { login } = await import('../src/app/login/actions');
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await login({}, form('placeholder-incorrect-password'));
      expect(result.error).toBe(
        'Unable to sign in. Check your username and password.',
      );
      expect(result.retryAfterSeconds).toBeUndefined();
    }
    const locked = await login({}, form('placeholder-incorrect-password'));
    expect(locked.retryAfterSeconds).toBe(300);
    expect(locked.error).toContain('Too many sign-in attempts');
    vi.advanceTimersByTime(1000);
    const blocked = await login({}, form('placeholder-password'));
    expect(blocked.retryAfterSeconds).toBe(299);
    expect(setCookie).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299000);
    await expect(login({}, form('placeholder-password'))).rejects.toThrow(
      'fixture redirect',
    );
    expect(setCookie).toHaveBeenCalledWith(
      'fixture-session',
      'placeholder-signed-session',
      {
        httpOnly: true,
        sameSite: 'strict',
        secure: true,
        path: '/',
        maxAge: 3600,
      },
    );
    expect(redirect).toHaveBeenCalledWith('/executions');
  });
});
