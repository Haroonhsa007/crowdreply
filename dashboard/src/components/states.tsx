import Link from 'next/link';
export function EmptyState({ filtered = false }: { filtered?: boolean }) {
  return (
    <div className="empty">
      <h2>
        {filtered ? 'No executions match these filters' : 'No executions yet'}
      </h2>
      <p className="muted">
        {filtered
          ? 'Clear the filters to see other executions.'
          : 'Submit a buyer question to collect your first provider answers.'}
      </p>
      <Link
        className="button"
        href={filtered ? '/executions' : '/executions/new'}
      >
        {filtered ? 'Clear filters' : 'Submit your first question'}
      </Link>
    </div>
  );
}
export function ErrorState({
  requestId,
  unauthorized = false,
}: {
  requestId?: string | null;
  unauthorized?: boolean;
}) {
  return (
    <section className="empty" role="alert">
      <h2>
        {unauthorized ? 'API access unavailable' : 'Could not load this data'}
      </h2>
      <p>
        {unauthorized
          ? 'The operator API credentials need attention.'
          : 'Try refreshing. If the problem continues, check the API service.'}
      </p>
      {requestId && <p className="mono">Request {requestId}</p>}
      <a className="button" href="">
        Try again
      </a>
    </section>
  );
}
export function LoadingTable() {
  return (
    <section aria-label="Loading executions" aria-busy="true">
      <h1>Executions</h1>
      <p className="muted">Checking the latest execution state…</p>
      {[1, 2, 3, 4, 5].map((row) => (
        <div key={row} style={{ padding: '20px 0' }}>
          <div className="skeleton" />
        </div>
      ))}
    </section>
  );
}
