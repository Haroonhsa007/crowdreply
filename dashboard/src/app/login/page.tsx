import { Brand } from '@/components/brand';
import { LoginForm } from './login-form';
import { safeNextPath } from '@/lib/auth/safe-next-path';
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  return (
    <main className="login-shell" id="main-content">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <Brand />
        </div>
        <div className="login-heading">
          <p className="scope">AI visibility · Operator workspace</p>
          <h1 id="login-title">Sign in to your workspace</h1>
          <p className="login-description muted">
            Inspect provider answers, citations and execution outcomes.
          </p>
        </div>
        <LoginForm next={safeNextPath((await searchParams).next)} />
        <div className="login-help">
          <p>
            Use the operator credentials supplied by your workspace
            administrator.
          </p>
          <details>
            <summary>Running this workspace locally?</summary>
            <p>
              Your deployment administrator configured the operator username and
              password when setting up this workspace. Ask them for access.
            </p>
            <p>
              If you manage the local deployment, find{' '}
              <code>OPERATOR_USERNAME</code> and <code>OPERATOR_PASSWORD</code>{' '}
              in its private <code>.env</code> file. Keep that file and its
              values private.
            </p>
          </details>
        </div>
        <p className="login-footer muted">
          Access is limited to this workspace’s operator.
        </p>
      </section>
    </main>
  );
}
