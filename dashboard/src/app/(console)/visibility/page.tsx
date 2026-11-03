import Link from 'next/link';
import { visibility } from '@/lib/api/extraction';
import { loadResource } from '@/lib/api/load-resource';
import { ErrorState } from '@/components/states';
import { IntegrationChip } from '@/components/integration-chip';
import { providerNames } from '@/lib/format/values';
export default async function VisibilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = Object.fromEntries(
    ['from', 'to', 'provider', 'includeMock'].flatMap((key) =>
      typeof params[key] === 'string' && params[key]
        ? [[key, params[key]]]
        : [],
    ),
  ) as Record<string, string>;
  const resource = await loadResource(() => visibility(query));
  if (!resource.ok)
    return (
      <>
        <h1>Visibility</h1>
        <ErrorState requestId={resource.requestId} />
      </>
    );
  const data = resource.data;
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Visibility</h1>
          <p className="muted">
            See which brands appear in provider answers, how often, and in what
            position. Ambiguous mentions are excluded.
          </p>
        </div>
      </header>
      <form className="filters">
        <label>
          From (UTC)
          <input type="date" name="from" defaultValue={data.from} required />
        </label>
        <label>
          To (UTC)
          <input type="date" name="to" defaultValue={data.to} required />
        </label>
        <label>
          Provider
          <select name="provider" defaultValue={query.provider ?? ''}>
            <option value="">All providers</option>
            {Object.entries(providerNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input
            type="checkbox"
            name="includeMock"
            value="true"
            defaultChecked={data.includeMock}
          />
          Include Mock evidence
        </label>
        <button>Apply filters</button>
      </form>
      <p className="muted">
        Completed extractions: {data.executionCounts.live} Live ·{' '}
        {data.executionCounts.mock} Mock.
      </p>
      {data.includesMock && (
        <p className="notice warning">
          This view includes Mock evidence. Synthetic results are separated from
          Live results.
        </p>
      )}
      {!data.items.length ? (
        <section className="empty">
          <h2>
            {!data.includeMock && !data.executionCounts.live
              ? 'No live data yet'
              : 'No eligible brand mentions in this range'}
          </h2>
          <p>
            Choose a UTC range of at most 366 days. Mock evidence is excluded by
            default.
          </p>
          {!data.includeMock && !data.executionCounts.live && (
            <Link
              className="button"
              href={`/visibility?${new URLSearchParams({ ...query, includeMock: 'true' })}`}
            >
              Explore Mock evidence
            </Link>
          )}
        </section>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Brand</th>
                <th>Provider</th>
                <th>Integration</th>
                <th className="num">Mentions</th>
                <th className="num">Average position</th>
                <th className="num">Mention share</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={`${item.provider}-${item.integration}-${item.brand}`}>
                  <td>{item.brand}</td>
                  <td>{providerNames[item.provider]}</td>
                  <td>
                    <IntegrationChip value={item.integration} />
                  </td>
                  <td className="num">{item.mentionCount}</td>
                  <td className="num">
                    {item.averagePosition?.toFixed(2) ?? (
                      <span aria-label="unknown">—</span>
                    )}
                  </td>
                  <td className="num">{(100 * item.share).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">{data.shareDefinition}</p>
      {data.truncated && (
        <p className="notice warning">
          Only the first 1,000 brand rows are shown. Narrow the date range or
          provider.
        </p>
      )}
    </>
  );
}
