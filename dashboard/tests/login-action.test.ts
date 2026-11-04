import { afterEach, describe, expect, it, vi } from 'vitest';

const { setCookie, redirect } = vi.hoisted(() => ({
  setCookie: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error('fixture redirect');
  }),
}));
vi.mock('../src/lib/auth/credentials', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/lib/auth/credentials')>();
  return { ...actual, verifyCredentials: vi.fn(actual.verifyCredentials) };
});
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

afterEach(() => {
  vi.useRealTimers();
});

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

describe('asynchronous sign-in reservation', () => {
  it('rejects concurrent attempts before deriving passwords and keeps the failure budget intact', async () => {
    vi.resetModules();
    const { verifyCredentials } = await import('../src/lib/auth/credentials');
    const check = vi.mocked(verifyCredentials);
    let finish: (valid: boolean) => void = () => {
      throw new Error('fixture verification not started');
    };
    check.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const { login } = await import('../src/app/login/actions');
    const pending = login({}, form('placeholder-incorrect-password'));
    const blocked = await Promise.all(
      Array.from({ length: 8 }, () => login({}, form('placeholder-password'))),
    );
    expect(check).toHaveBeenCalledTimes(1);
    for (const result of blocked) {
      expect(result.error).toContain('Too many sign-in attempts');
      expect(result.retryAfterSeconds).toBe(1);
    }
    expect(setCookie).not.toHaveBeenCalled();
    finish(false);
    expect((await pending).error).toBe(
      'Unable to sign in. Check your username and password.',
    );
    check.mockResolvedValue(false);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        (await login({}, form('placeholder-incorrect-password')))
          .retryAfterSeconds,
      ).toBeUndefined();
    }
    expect(
      (await login({}, form('placeholder-incorrect-password')))
        .retryAfterSeconds,
    ).toBeGreaterThan(0);
    expect(check).toHaveBeenCalledTimes(5);
    await login({}, form('placeholder-password'));
    expect(check).toHaveBeenCalledTimes(5);
  });

  it('releases the reservation if verification throws and after a successful redirect', async () => {
    vi.resetModules();
    const { verifyCredentials } = await import('../src/lib/auth/credentials');
    const check = vi.mocked(verifyCredentials);
    check
      .mockRejectedValueOnce(new Error('fixture derivation failed'))
      .mockResolvedValue(true);
    const { login } = await import('../src/app/login/actions');
    await expect(login({}, form('placeholder-password'))).rejects.toThrow(
      'fixture derivation failed',
    );
    await expect(login({}, form('placeholder-password'))).rejects.toThrow(
      'fixture redirect',
    );
    await expect(login({}, form('placeholder-password'))).rejects.toThrow(
      'fixture redirect',
    );
    expect(check).toHaveBeenCalledTimes(3);
    expect(setCookie).toHaveBeenCalledTimes(2);
  });
});
