import Link from 'next/link';
import type { ApiExecutionView } from '@contracts';
import { ExecutionStatusChip } from './execution-status-chip';
import { ExtractionStatusChip } from './extraction-status-chip';
import { IntegrationChip } from './integration-chip';
import { CitationChip } from './citation-chip';
import { LocalTime } from './local-time';
import { EmptyState } from './states';
import { formatCost, formatDuration, providerNames } from '@/lib/format/values';

export function ExecutionTable({
  items,
  filtered = false,
}: {
  items: ApiExecutionView[];
  filtered?: boolean;
}) {
  if (!items.length) return <EmptyState filtered={filtered} />;
  return (
    <ul className="answer-list" aria-label="Provider answers">
      {items.map((item) => (
        <li className="answer-row" key={item.id}>
          <div className="answer-row-content">
            <div className="answer-row-meta">
              <strong>{providerNames[item.provider]}</strong>
              <IntegrationChip value={item.integration} />
              <ExecutionStatusChip value={item.status} />
            </div>
            <Link className="answer-question" href={`/executions/${item.id}`}>
              {item.questionText}
            </Link>
            <div className="answer-evidence">
              <span>
                Brands <ExtractionStatusChip value={item.extractionStatus} />
              </span>
              <CitationChip value={item.citationsAvailable} />
            </div>
            <details className="run-details">
              <summary>Run details</summary>
              <dl className="facts">
                <dt>Model</dt>
                <dd>{item.model}</dd>
                <dt>Latency</dt>
                <dd
                  className="num"
                  aria-label={
                    item.latencyMs == null ? 'Latency unknown' : undefined
                  }
                >
                  {formatDuration(item.latencyMs)}
                </dd>
                <dt>Estimated cost</dt>
                <dd
                  className="num"
                  aria-label={
                    item.cost?.totalUsd == null
                      ? 'Estimated cost unknown'
                      : undefined
                  }
                >
                  {formatCost(item.cost?.totalUsd)}
                </dd>
                <dt>Created</dt>
                <dd>
                  <LocalTime value={item.createdAt} />
                </dd>
              </dl>
            </details>
          </div>
          <div className="answer-row-actions">
            <Link className="button" href={`/executions/${item.id}`}>
              {item.status === 'succeeded'
                ? 'Read answer'
                : ['dead', 'unknown_outcome'].includes(item.status)
                  ? 'Review issue'
                  : 'View progress'}
            </Link>
            <LocalTime value={item.createdAt} />
          </div>
        </li>
      ))}
    </ul>
  );
}
