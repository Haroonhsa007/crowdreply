import type { RawResponse } from '../../src/contracts/index.js';

/** Synthetic assessment answer and root URLs; no captured provider output. */
export const assessmentRaw: RawResponse = {
  executionId: 'synthetic-extraction',
  body: { synthetic: true },
  outputText: [
    'Best CRM for a 10-person B2B startup:',
    '1. **HubSpot CRM** — a broad CRM option.',
    '2. **Pipedrive** — focused sales pipelines.',
    '3. **Attio** — adaptable CRM workflows.',
    '4. **Close** — a CRM for outbound sales teams.',
    '5. **Salesforce Starter Suite** — an integrated sales suite.',
    'HubSpot offers a free tier; HubSpot CRM also has paid plans.',
  ].join('\n'),
  citations: [
    'hubspot.com',
    'pipedrive.com',
    'attio.com',
    'softwarecompare.net',
    'close.com',
    'salesforce.com',
  ].map((domain) => ({ url: `https://${domain}/`, domain })),
  providerResponseId: 'synthetic-response',
  createdAt: '2026-11-02T00:00:00.000Z',
};
export const context = {
  executionId: assessmentRaw.executionId,
  provider: 'openai' as const,
  integration: 'mock' as const,
  runDate: '2026-11-02',
};
