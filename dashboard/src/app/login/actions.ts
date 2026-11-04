'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from '@/lib/env';
import { loginLimiter, verifyCredentials } from '@/lib/auth/credentials';
import {
  SESSION_COOKIE,
  SESSION_SECONDS,
  signSession,
} from '@/lib/auth/session';
import { safeNextPath } from '@/lib/auth/safe-next-path';
const limiter = loginLimiter();
export async function login(
  _previous: { error?: string; retryAfterSeconds?: number },
  form: FormData,
): Promise<{ error?: string; retryAfterSeconds?: number }> {
  if (!limiter.acquire()) {
    return {
      error:
        'Too many sign-in attempts. Wait for the cooldown, then try again.',
      retryAfterSeconds: Math.max(1, limiter.remainingSeconds()),
    };
  }
  try {
    const config = env();
    const username = form.get('username');
    const password = form.get('password');
    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !(await verifyCredentials(
        username,
        password,
        config.OPERATOR_USERNAME,
        config.OPERATOR_PASSWORD,
      ))
    ) {
      limiter.failed();
      const retryAfterSeconds = limiter.remainingSeconds();
      return retryAfterSeconds > 0
        ? {
            error:
              'Too many sign-in attempts. Wait for the cooldown, then try again.',
            retryAfterSeconds,
          }
        : { error: 'Unable to sign in. Check your username and password.' };
    }
    limiter.reset();
    (await cookies()).set(
      SESSION_COOKIE,
      await signSession(config.SESSION_SECRET),
      {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.NODE_ENV === 'production',
        path: '/',
        maxAge: SESSION_SECONDS,
      },
    );
    redirect(safeNextPath(form.get('next')));
  } finally {
    limiter.release();
  }
}
