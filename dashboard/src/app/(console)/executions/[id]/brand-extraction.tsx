import type { ExtractionStatus, Citation } from '@contracts';
import type { ExtractionDetail } from '@/lib/api/extraction';
import { ExtractionStatusChip } from '@/components/extraction-status-chip';
import { IntegrationChip } from '@/components/integration-chip';
import { LocalTime } from '@/components/local-time';
export function BrandExtraction({
  detail,
  status,
  citations = [],
}: {
  detail: ExtractionDetail | null;
  status: ExtractionStatus;
  citations?: Citation[];
}) {
  const current = detail?.current;
  return (
    <section className="section">
      <div className="section-heading">
        <h2>Brands</h2>
        <ExtractionStatusChip value={current?.status ?? status} />
      </div>
      {!detail ? (
        <p className="notice warning">
          Brand extraction data could not be loaded. Try refreshing.
        </p>
      ) : !current ? (
        <p className="muted">
          Extraction has not run for this execution. No validated brands or
          positions are available yet.
        </p>
      ) : (
        <>
          {current.integration === 'mock' && (
            <p className="notice warning">
              Mock brands are synthetic evidence and are excluded from live
              visibility by default.
            </p>
          )}
          {['pending', 'extracting'].includes(current.status) && (
            <p className="muted">
              Extraction is queued or running. The provider answer is already
              saved.
            </p>
          )}
          {current.status === 'extraction_failed' && (
            <p role="alert" className="notice warning">
              {current.error?.message ??
                'Brand extraction failed. The saved provider answer is unchanged.'}
            </p>
          )}
          {current.status === 'extracted' &&
            (current.mentions.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Brand</th>
                      <th>Alias as written</th>
                      <th>Position</th>
                      <th>Mentions</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.mentions.map((mention, index) => (
                      <tr key={`${mention.brand}-${index}`}>
                        <td>
                          {mention.brand}
                          {mention.ambiguous && (
                            <p className="notice warning">
                              Ambiguous: {mention.ambiguityReason}
                            </p>
                          )}
                        </td>
                        <td>{mention.alias}</td>
                        <td className="num">
                          {mention.position ?? (
                            <span aria-label="unknown">—</span>
                          )}
                        </td>
                        <td className="num">{mention.mentionCount}</td>
                        <td>
                          {mention.citationIndexes
                            .flatMap((citationIndex) =>
                              citations[citationIndex]
                                ? [citations[citationIndex]!]
                                : [],
                            )
                            .map((citation, citationIndex) => (
                              <p key={`${citation.url}-${citationIndex}`}>
                                <a
                                  href={citation.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {citation.domain}
                                </a>
                              </p>
                            ))}
                          {!mention.citationIndexes.length && (
                            <span className="muted">
                              No supported citation link
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">
                No supported brand mentions were detected in this answer.
              </p>
            ))}
          {!!current.citedDomains.length && (
            <p className="muted">
              Cited domains in the saved answer:{' '}
              {current.citedDomains.join(', ')}. Citation links above require
              supporting evidence.
            </p>
          )}
          <details className="technical-details">
            <summary>Brand detection details</summary>
            <p className="muted">
              Extractor version{' '}
              <span className="mono">{current.extractorVersion}</span> ·{' '}
              {current.method === 'rule_based' ? 'Rule based' : 'LLM'} ·{' '}
              <IntegrationChip value={current.integration} />
            </p>
            {detail.history.length > 1 && (
              <details>
                <summary>
                  Extraction history ({detail.history.length} most recent
                  versions)
                </summary>
                <ul>
                  {detail.history.map((version) => (
                    <li key={version.id}>
                      <span className="mono">{version.extractorVersion}</span> ·{' '}
                      {version.status} · <LocalTime value={version.createdAt} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </details>
        </>
      )}
    </section>
  );
}
