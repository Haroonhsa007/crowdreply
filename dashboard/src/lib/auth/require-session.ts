import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from '../env';
import { SESSION_COOKIE, verifySession } from './session';
export async function requireSession(): Promise<void> {
  if (
    !(await verifySession(
      (await cookies()).get(SESSION_COOKIE)?.value,
      env().SESSION_SECRET,
    ))
  )
    redirect('/login');
}
