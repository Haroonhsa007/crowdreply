'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/require-session';
import { SESSION_COOKIE } from '@/lib/auth/session';
export async function logout() {
  await requireSession();
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
