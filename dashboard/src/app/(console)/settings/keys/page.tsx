import { PaidExecutionNotice } from '@/components/paid-execution-notice';
import { providers } from '@/lib/api/providers';
import { loadResource } from '@/lib/api/load-resource';
import { ErrorState } from '@/components/states';
import { IntegrationChip } from '@/components/integration-chip';
import { providerNames } from '@/lib/format/values';
import { KeyExpiry, KeyForm } from './key-form';
export default async function KeysPage() {
  const resource = await loadResource(providers);
  if (!resource.ok)
    return (
      <>
        <h1>Provider keys</h1>
        <PaidExecutionNotice />
        <ErrorState requestId={resource.requestId} />
      </>
    );
  const items = resource.data;
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="muted">Settings</p>
          <h1>Provider keys</h1>
          <p className="muted">
            Configured access uses your temporary key first, then the server
            key, then Mock.
          </p>
        </div>
      </header>
      <PaidExecutionNotice />
      {items.map((item) => (
        <section className="provider-row" key={item.provider}>
          <div>
            <h2>{providerNames[item.provider]}</h2>
            <IntegrationChip value={item.mode} />
            <p className="muted" style={{ marginTop: 12 }}>
              {item.keySource === 'user' && item.expiresAt ? (
                <KeyExpiry
                  value={item.expiresAt}
                  initialNow={Date.parse(resource.updatedAt)}
                />
              ) : item.keySource === 'env' ? (
                'Using the server key'
              ) : (
                'Mock'
              )}
            </p>
          </div>
          {item.liveSupported ? (
            <KeyForm provider={item.provider} />
          ) : (
            <p className="notice">
              Mock only: no supported API. Google AI search is distinct from
              Gemini; no key can be added.
            </p>
          )}
        </section>
      ))}
    </>
  );
}
