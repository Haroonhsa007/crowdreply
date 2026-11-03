import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from './lib/auth/session';
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/login') return NextResponse.next();
  if (
    await verifySession(
      request.cookies.get(SESSION_COOKIE)?.value,
      process.env.SESSION_SECRET ?? '',
    )
  )
    return NextResponse.next();
  const target = new URL('/login', request.url);
  target.searchParams.set(
    'next',
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return NextResponse.redirect(target);
}
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
