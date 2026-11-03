import Link from 'next/link';
import { executions } from '@/lib/api/executions';
import { loadResource } from '@/lib/api/load-resource';
import { ExecutionTable } from '@/components/execution-table';
import { ErrorState } from '@/components/states';
import { AutoRefresh } from '@/components/auto-refresh';
import { LocalTime } from '@/components/local-time';
import { ProviderIdSchema, ExecutionStatusSchema } from '@contracts';
import { executionStatuses } from '@/components/execution-status-chip';
import { providerNames } from '@/lib/format/values';
export default async function ExecutionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = Object.fromEntries(
    ['provider', 'status', 'before', 'limit'].flatMap((key) =>
      typeof params[key] === 'string' && params[key]
        ? [[key, params[key]]]
        : [],
    ),
  ) as Record<string, string>;
  const resource = await loadResource(() => executions(query));
  if (!resource.ok)
    return (
      <>
        <h1>Answers</h1>
        <ErrorState
          requestId={resource.requestId}
          unauthorized={resource.unauthorized}
        />
      </>
    );
  const page = resource.data;
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Answers</h1>
          <p className="muted">
            Open a question to inspect its answer, citations and execution
            history.
          </p>
        </div>
        <Link className="button primary" href="/executions/new">
          Ask a question
        </Link>
      </header>
      <form className="filters" aria-label="Filter executions">
        <label>
          Provider
          <select name="provider" defaultValue={query.provider ?? ''}>
            <option value="">All providers</option>
            {ProviderIdSchema.options.map((p) => (
              <option key={p} value={p}>
                {providerNames[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Execution status
          <select name="status" defaultValue={query.status ?? ''}>
            <option value="">All statuses</option>
            {ExecutionStatusSchema.options.map((status) => (
              <option key={status} value={status}>
                {executionStatuses[status][0]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rows
          <select name="limit" defaultValue={query.limit ?? '25'}>
            {[25, 50, 100].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button>Apply filters</button>
        <Link href="/executions">Clear filters</Link>
      </form>
      <ExecutionTable
        items={page.items}
        filtered={Boolean(query.provider || query.status)}
      />
      <p className="muted">
        Last updated <LocalTime value={resource.updatedAt} /> ·{' '}
        <AutoRefresh
          statuses={page.items.map((item) => item.status)}
          extractionStatuses={page.items
            .filter((item) => item.status === 'succeeded')
            .map((item) => item.extractionStatus)}
        />
      </p>
      {page.nextBefore && (
        <Link
          className="button"
          href={`/executions?${new URLSearchParams({ ...query, before: page.nextBefore })}`}
        >
          Older executions
        </Link>
      )}
    </>
  );
}
