import type { ProviderRequest } from '../contracts/index.js';
import { array, number, object, requestJson, text } from './http.js';
import { citation, result, type LiveOptions } from './normalize.js';

export async function executePerplexity(
  request: ProviderRequest,
  options: LiveOptions,
  signal: AbortSignal,
) {
  const started = new Date().toISOString();
  const response = await requestJson({
    url: 'https://api.perplexity.ai/v1/agent',
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: {
      model: options.model,
      input: request.questionText,
      instructions: 'Search first; cite sources inline.',
      tools: request.settings.webSearch ? [{ type: 'web_search' }] : [],
      max_output_tokens: 1024,
    },
    signal,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
  });
  const raw = object(response.json);
  const output = array(raw.output).map(object);
  const textBlocks = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => array(item.content).map(object));
  const citations = output
    .filter((item) => item.type === 'search_results')
    .flatMap((item) => array(item.results))
    .map(citation)
    .filter((v) => v !== null);
  const usage = object(raw.usage);
  const cost = object(usage.cost);
  const normalized = result(
    request,
    response.json,
    textBlocks
      .filter((item) => item.type === 'output_text')
      .map((item) => text(item.text))
      .join('\n'),
    citations,
    {
      inputTokens: number(usage.input_tokens),
      outputTokens: number(usage.output_tokens),
      toolCalls: number(usage.tool_calls),
    },
    started,
    text(raw.id) || response.headers.get('x-request-id'),
  );
  if (number(cost.total_cost) !== null)
    normalized.cost = {
      tokensUsd:
        number(cost.input_cost) === null || number(cost.output_cost) === null
          ? null
          : Number(cost.input_cost) + Number(cost.output_cost),
      toolsUsd: number(cost.tool_calls_cost),
      totalUsd: number(cost.total_cost),
    };
  return normalized;
}
