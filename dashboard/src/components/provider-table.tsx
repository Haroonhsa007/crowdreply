import type { ApiProviderStatus } from '@contracts';
import { IntegrationChip } from './integration-chip';
import { providerNames } from '@/lib/format/values';
const notes = {
  openai: 'Answers with web search when Live',
  perplexity: 'Search answers and source pages when Live',
  gemini: 'Answers grounded in Google Search when Live',
  anthropic: 'Answers with web search when Live',
  google_ai: 'Mock only: no supported API. Separate from Gemini.',
};
export function ProviderTable({ items }: { items: ApiProviderStatus[] }) {
  return (
    <div className="table-wrap">
      <table className="provider-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Configured mode</th>
            <th scope="col">Access / capability</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.provider}>
              <td data-label="Provider">{providerNames[item.provider]}</td>
              <td data-label="Configured mode">
                <IntegrationChip value={item.mode} />
              </td>
              <td data-label="Access / capability">
                {item.keySource === 'user'
                  ? 'Your temporary key'
                  : item.keySource === 'env'
                    ? 'Server key'
                    : 'No key configured'}
                <span className="subline">{notes[item.provider]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
