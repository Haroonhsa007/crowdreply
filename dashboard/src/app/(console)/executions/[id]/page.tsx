import Link from 'next/link';
import { execution } from '@/lib/api/executions';
import { extraction } from '@/lib/api/extraction';
import { BrandExtraction } from './brand-extraction';
import { loadResource } from '@/lib/api/load-resource';
import { ErrorState } from '@/components/states';
import { ExecutionStatusChip } from '@/components/execution-status-chip';
import { ExtractionStatusChip } from '@/components/extraction-status-chip';
import { IntegrationChip } from '@/components/integration-chip';
import { CitationChip } from '@/components/citation-chip';
import { LocalTime } from '@/components/local-time';
import { AutoRefresh } from '@/components/auto-refresh';
import {
  formatCost,
  formatCount,
  formatDuration,
  providerNames,
} from '@/lib/format/values';

const answerStates = {
  queued: {
    heading: 'Waiting to ask the provider',
    description:
      'Your question is in the queue. The answer will appear here once it is saved.',
  },
  running: {
    heading: 'Waiting for the provider’s answer',
    description:
      'Your question is being processed. This page updates automatically while the answer is collected.',
  },
  retry_wait: {
    heading: 'Another attempt is scheduled',
    description:
      'The previous attempt could not complete. The workspace is waiting before trying again.',
  },
  succeeded: {
    heading: 'The saved answer is unavailable',
    description:
      'The provider completed this run, but no answer text is available here. Try refreshing the page.',
  },
  dead: {
    heading: 'No answer was saved',
    description:
      'The available attempts ended without a saved answer. Check Technical details for the last error before trying again.',
  },
  unknown_outcome: {
    heading: 'The result could not be confirmed',
    description:
      'No confirmed answer is available. The provider may have processed this question; check the request before submitting it again.',
  },
};

export default async function DetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  const resource = await loadResource(() => execution(id));
  if (!resource.ok)
    return (
      <>
        <Link className="back-link" href="/executions">
          ← Back to answers
        </Link>
        <h1>Answer unavailable</h1>
        <ErrorState
          requestId={resource.requestId}
          unauthorized={resource.unauthorized}
        />
      </>
    );
  const item = resource.data;
  const extractionResource = await loadResource(() => extraction(id));
  const answerState = answerStates[item.status];
  return (
    <>
      <Link className="back-link" href="/executions">
        ← Back to answers
      </Link>
      <header className="page-heading">
        <div>
          <div className="chips">
            <span>{providerNames[item.provider]}</span>
            <IntegrationChip value={item.integration} />
          </div>
          <h1>{item.questionText}</h1>
          <p className="muted">
            Asked <LocalTime value={item.createdAt} />
          </p>
        </div>
      </header>
      {item.integration === 'mock' && (
        <p className="notice warning">
          Mock mode uses simulated answers, not live provider responses. These
          results are excluded from live visibility evidence and spend.
        </p>
      )}
      {item.status === 'unknown_outcome' && (
        <p className="notice warning">
          The provider may have charged for this request, but its result was not
          confirmed. Automatic retry is disabled. Check the request before
          making another paid call.
        </p>
      )}
      <div className="answer-layout section">
        <section
          className="answer-main"
          aria-labelledby="provider-answer-title"
        >
          <h2 id="provider-answer-title">Provider answer</h2>
          {item.raw?.outputText ? (
            <p className="answer">{item.raw.outputText}</p>
          ) : (
            <div className="answer-empty">
              <h3>{answerState.heading}</h3>
              <p className="muted">{answerState.description}</p>
              {item.status === 'retry_wait' && item.retryAt && (
                <p className="muted">
                  Next attempt <LocalTime value={item.retryAt} />
                </p>
              )}
            </div>
          )}
        </section>
        <aside
          className="answer-sidebar"
          aria-labelledby="answer-citations-title"
        >
          <div className="section-heading">
            <h2 id="answer-citations-title">Citations</h2>
          </div>
          <CitationChip value={item.citationsAvailable} />
          {item.raw?.citations.length ? (
            <ul>
              {item.raw.citations.map((citation, i) => (
                <li key={`${citation.url}-${i}`}>
                  <a
                    className="mono"
                    href={citation.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {citation.domain}
                  </a>
                  {citation.title && <p className="muted">{citation.title}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {item.raw
                ? 'No source links were included in the stored answer.'
                : 'Source links will appear here if the provider returns them.'}
            </p>
          )}
        </aside>
      </div>
      <BrandExtraction
        detail={extractionResource.ok ? extractionResource.data : null}
        status={item.extractionStatus}
        citations={item.raw?.citations}
      />
      <details className="technical-details section">
        <summary>Technical details</summary>
        <p className="muted">
          Run status and identifiers for troubleshooting this answer.
        </p>
        <div className="chips">
          <ExecutionStatusChip value={item.status} />
          <ExtractionStatusChip value={item.extractionStatus} />
        </div>
        <dl className="facts">
          <dt>Provider</dt>
          <dd>{providerNames[item.provider]}</dd>
          <dt>Model</dt>
          <dd>{item.model}</dd>
          <dt>Execution ID</dt>
          <dd className="mono">{item.id}</dd>
          <dt>Execution key</dt>
          <dd className="mono">{item.executionKey}</dd>
          <dt>Provider response ID</dt>
          <dd className="mono">
            {item.raw?.providerResponseId ?? (
              <span aria-label="unknown">—</span>
            )}
          </dd>
          <dt>Created</dt>
          <dd>
            <LocalTime value={item.createdAt} />
          </dd>
          <dt>Created date (UTC)</dt>
          <dd className="num">{item.createdAt.slice(0, 10)}</dd>
          <dt>Completed</dt>
          <dd>
            {item.completedAt ? (
              <LocalTime value={item.completedAt} />
            ) : (
              <span aria-label="unknown">—</span>
            )}
          </dd>
          <dt>Attempts</dt>
          <dd className="num">{formatCount(item.attemptCount)}</dd>
          <dt>Last error</dt>
          <dd>{item.lastErrorCategory ?? 'No error recorded'}</dd>
          <dt>Next retry</dt>
          <dd>
            {item.retryAt ? (
              <LocalTime value={item.retryAt} />
            ) : (
              'Not scheduled'
            )}
          </dd>
          <dt>Latency</dt>
          <dd
            className="num"
            aria-label={item.latencyMs == null ? 'unknown' : undefined}
          >
            {formatDuration(item.latencyMs)}
          </dd>
          <dt>Input tokens</dt>
          <dd
            className="num"
            aria-label={item.usage?.inputTokens == null ? 'unknown' : undefined}
          >
            {formatCount(item.usage?.inputTokens)}
          </dd>
          <dt>Output tokens</dt>
          <dd
            className="num"
            aria-label={
              item.usage?.outputTokens == null ? 'unknown' : undefined
            }
          >
            {formatCount(item.usage?.outputTokens)}
          </dd>
          <dt>Tool calls</dt>
          <dd
            className="num"
            aria-label={item.usage?.toolCalls == null ? 'unknown' : undefined}
          >
            {formatCount(item.usage?.toolCalls)}
          </dd>
          <dt>Estimated cost</dt>
          <dd
            className="num"
            aria-label={item.cost?.totalUsd == null ? 'unknown' : undefined}
          >
            {formatCost(item.cost?.totalUsd)}
          </dd>
        </dl>
        <p className="muted">— means unknown, not zero. Costs are estimates.</p>
      </details>
      <p className="muted">
        Last checked <LocalTime value={resource.updatedAt} /> ·{' '}
        <AutoRefresh
          statuses={[item.status]}
          extractionStatuses={
            item.status === 'succeeded' ? [item.extractionStatus] : []
          }
        />
      </p>
    </>
  );
}
