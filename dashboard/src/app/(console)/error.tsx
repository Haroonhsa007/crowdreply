'use client';
export default function ErrorBoundary({ reset }: { reset: () => void }) {
  return (
    <section className="empty" role="alert">
      <h1>Could not load this view</h1>
      <p>The service may be temporarily unavailable.</p>
      <button onClick={reset}>Try again</button>
    </section>
  );
}
