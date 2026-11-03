import Link from 'next/link';
import { executions } from '@/lib/api/executions';
import { providers } from '@/lib/api/providers';
import { spend } from '@/lib/api/spend';
import { loadResource } from '@/lib/api/load-resource';
import { ExecutionTable } from '@/components/execution-table';
import { ProviderTable } from '@/components/provider-table';
import { PaidExecutionNotice } from '@/components/paid-execution-notice';
import { ErrorState } from '@/components/states';
import { AutoRefresh } from '@/components/auto-refresh';
import { LocalTime } from '@/components/local-time';
import { formatCost, formatCount } from '@/lib/format/values';
import { QuestionForm } from './executions/new/question-form';
export default async function OverviewPage() {
  const [executionResource, providerResource, spendResource] =
    await Promise.all([
      loadResource(() => executions({ limit: '100' })),
      loadResource(providers),
      loadResource(spend),
    ]);
  const items = executionResource.ok ? executionResource.data.items : [];
  const failures = items.filter((item) =>
    ['dead', 'unknown_outcome'].includes(item.status),
  );
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Ask a buyer question</h1>
          <p className="muted">
            See what AI providers recommend, then explore their answers and
            sources.
          </p>
        </div>
      </header>
      <QuestionForm
        compact
        providerStatuses={
          providerResource.ok ? providerResource.data : undefined
        }
      />
      {failures.length > 0 && (
        <aside
          className="overview-summary"
          aria-label="Runs that need attention"
        >
          <p>{formatCount(failures.length)} recent runs need attention.</p>
          <div className="attention-links">
            <Link href="/executions?status=dead">Review failed runs</Link>
            <Link href="/executions?status=unknown_outcome">
              Review unknown outcomes
            </Link>
          </div>
        </aside>
      )}
      <section className="section" aria-labelledby="recent-questions-title">
        <div className="section-heading">
          <h2 id="recent-questions-title">Recent questions</h2>
          <Link href="/executions">View all answers</Link>
        </div>
        {executionResource.ok ? (
          <>
            <ExecutionTable items={items.slice(0, 3)} />
            <p className="muted">
              Updated <LocalTime value={executionResource.updatedAt} /> ·{' '}
              <AutoRefresh
                statuses={items.map((item) => item.status)}
                extractionStatuses={items
                  .filter((item) => item.status === 'succeeded')
                  .map((item) => item.extractionStatus)}
              />
            </p>
          </>
        ) : (
          <ErrorState
            requestId={executionResource.requestId}
            unauthorized={executionResource.unauthorized}
          />
        )}
      </section>
      <details className="workspace-health section">
        <summary>
          Workspace health{' '}
          <span className="muted">· provider access, activity and spend</span>
        </summary>
        <div className="workspace-health-content">
          {executionResource.ok && (
            <>
              <p className="muted">
                Activity covers the most recent 100 executions. Mock answers are
                test data.
              </p>
              <dl className="metrics">
                <div>
                  <dt>Live executions</dt>
                  <dd>
                    {formatCount(
                      items.filter((item) => item.integration === 'live')
                        .length,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Mock executions</dt>
                  <dd>
                    {formatCount(
                      items.filter((item) => item.integration === 'mock')
                        .length,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Queued, running or retrying</dt>
                  <dd>
                    {formatCount(
                      items.filter((item) =>
                        ['queued', 'running', 'retry_wait'].includes(
                          item.status,
                        ),
                      ).length,
                    )}
                  </dd>
                </div>
              </dl>
            </>
          )}
          <div className="workspace-columns">
            <section>
              <div className="section-heading">
                <h2>Provider access</h2>
                <Link href="/settings/keys">Manage keys</Link>
              </div>
              {providerResource.ok ? (
                <ProviderTable items={providerResource.data} />
              ) : (
                <ErrorState
                  requestId={providerResource.requestId}
                  unauthorized={providerResource.unauthorized}
                />
              )}
            </section>
            <section className="panel">
              <h2>Live spend cap</h2>
              {spendResource.ok ? (
                <>
                  <p className="num">
                    <span
                      aria-label={
                        spendResource.data.totalUsd === null
                          ? 'Live spend unknown'
                          : undefined
                      }
                    >
                      {formatCost(spendResource.data.totalUsd)}
                    </span>{' '}
                    / {formatCost(spendResource.data.capUsd)}
                  </p>
                  <p className="muted">
                    Includes server keys, temporary keys and retries. Mock runs
                    cost nothing.
                  </p>
                  {spendResource.data.totalUsd === null ? (
                    <p className="notice warning">
                      Spend is unknown. Live calls are blocked until reconciled.
                    </p>
                  ) : (
                    <>
                      <progress
                        aria-label="Live spend used"
                        value={spendResource.data.totalUsd}
                        max={spendResource.data.capUsd}
                      />
                      <p
                        className="num muted"
                        aria-label={
                          spendResource.data.remainingUsd === null
                            ? 'Remaining spend unknown'
                            : undefined
                        }
                      >
                        {formatCost(spendResource.data.remainingUsd)} remaining
                      </p>
                    </>
                  )}
                </>
              ) : (
                <ErrorState
                  requestId={spendResource.requestId}
                  unauthorized={spendResource.unauthorized}
                />
              )}
              <PaidExecutionNotice />
            </section>
          </div>
        </div>
      </details>
    </>
  );
}
