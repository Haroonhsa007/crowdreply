import { PaidExecutionNotice } from '@/components/paid-execution-notice';
import Link from 'next/link';
import { providers } from '@/lib/api/providers';
import { ProviderTable } from '@/components/provider-table';
import { ErrorState } from '@/components/states';
import { loadResource } from '@/lib/api/load-resource';
export default async function ProvidersPage() {
  const resource = await loadResource(providers);
  if (!resource.ok)
    return (
      <>
        <h1>Providers</h1>
        <PaidExecutionNotice />
        <ErrorState requestId={resource.requestId} />
      </>
    );
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Providers</h1>
          <p className="muted">
            The table shows configured access. Historical executions keep their
            original mode.
          </p>
        </div>
        <Link className="button" href="/settings/keys">
          Manage keys
        </Link>
      </header>
      <PaidExecutionNotice />
      <ProviderTable items={resource.data} />
      <p className="muted section">
        Your temporary key takes precedence over the server key. Without either,
        the provider runs as Mock. Google AI search remains mock-only.
      </p>
    </>
  );
}
