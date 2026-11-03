import Link from 'next/link';
import { requireSession } from '@/lib/auth/require-session';
import { Brand } from '@/components/brand';
import { Navigation } from '@/components/nav';
import { logout } from './actions';
export const dynamic = 'force-dynamic';
export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace">
        <Navigation
          header={
            <>
              <Link
                className="sidebar-brand"
                href="/"
                aria-label="CrowdReply overview"
              >
                <Brand />
              </Link>
              <p className="scope">AI visibility · Operator workspace</p>
            </>
          }
          footer={
            <div className="sidebar-footer">
              <p className="muted">Operator access</p>
              <form action={logout}>
                <button>Sign out</button>
              </form>
            </div>
          }
        />
      </aside>
      <main className="sheet" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
