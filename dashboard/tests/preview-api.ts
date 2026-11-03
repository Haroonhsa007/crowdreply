/** Local synthetic UI fixture only. No database, queue, provider or real credentials. */
import { createServer } from 'node:http';
const providers = ['openai', 'perplexity', 'gemini', 'anthropic', 'google_ai'];
let state = 'normal';
const items = providers.map((provider, index) => ({
  id: `synthetic-${index}`,
  executionKey: String(index + 1).repeat(64),
  questionText: [
    'Best CRM for small agencies?',
    'Best CRM for a 10-person B2B startup?',
    'Which CRM has simple pipelines?',
    'CRM for an outbound sales team?',
    'Best CRM for remote teams?',
  ][index],
  provider,
  integration: 'mock',
  model: 'synthetic-preview-model',
  status: index === 3 ? 'dead' : 'succeeded',
  extractionStatus: 'pending',
  citationsAvailable: index === 2 ? 'no' : 'yes',
  attemptCount: 1,
  latencyMs: 850 + index * 120,
  usage: { inputTokens: null, outputTokens: null, toolCalls: null },
  cost: { tokensUsd: 0, toolsUsd: 0, totalUsd: 0 },
  createdAt: '2026-11-02T23:45:00.000Z',
  completedAt: '2026-11-02T23:45:01.000Z',
}));
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:32101');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/__preview/state' && req.method === 'POST') {
    state = url.searchParams.get('state') ?? 'normal';
    res.end('{}');
    return;
  }
  if (state === 'slow')
    await new Promise((resolve) => setTimeout(resolve, 3000));
  if (state === 'error') {
    res.statusCode = 503;
    res.end('{"error":"Synthetic preview failure"}');
    return;
  }
  if (url.pathname === '/providers')
    res.end(
      JSON.stringify({
        items: providers.map((provider) => ({
          provider,
          liveSupported: provider !== 'google_ai',
          mode: 'mock',
          keySource: 'none',
        })),
      }),
    );
  else if (url.pathname === '/spend')
    res.end(JSON.stringify({ totalUsd: 0, capUsd: 2, remainingUsd: 2 }));
  else if (url.pathname === '/executions')
    res.end(JSON.stringify({ items: state === 'empty' ? [] : items }));
  else if (url.pathname.startsWith('/executions/'))
    res.end(
      JSON.stringify({
        ...items.find((item) => url.pathname.endsWith(item.id)),
        raw: {
          outputText:
            'Mock answer — synthetic UI fixture, not live evidence.\n1. HubSpot CRM\n2. Pipedrive\n3. Attio',
          citations: [
            {
              url: 'https://hubspot.com/',
              domain: 'hubspot.com',
              title: 'HubSpot',
            },
          ],
          providerResponseId: 'mock-preview',
        },
      }),
    );
  else {
    res.statusCode = 404;
    res.end('{}');
  }
});
server.listen(32101, '127.0.0.1', () =>
  process.stdout.write('Synthetic preview API listening on loopback:32101\n'),
);
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
