import { type ProviderRequest } from '../contracts/index.js';
import { array, number, object, requestJson, text } from './http.js';
import { citation, result, type LiveOptions } from './normalize.js';
import { PaidProviderError } from './paid-error.js';
import { estimateCost } from './pricing.js';

export async function executeOpenAI(
  request: ProviderRequest,
  options: LiveOptions,
  signal: AbortSignal,
) {
  const started = new Date().toISOString();
  const response = await requestJson({
    url: 'https://api.openai.com/v1/responses',
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: {
      model: options.model,
      input: request.questionText,
      store: false,
      max_output_tokens: 1024,
      ...(request.settings.webSearch
        ? {
            tools: [{ type: 'web_search', search_context_size: 'low' }],
            tool_choice: 'required',
            include: ['web_search_call.action.sources'],
            max_tool_calls: 2,
          }
        : {}),
    },
    signal,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
  });
  const raw = object(response.json);
  const output = array(raw.output).map(object);
  const content: Record<string, unknown>[] = [];
  const citationProvenance: Record<string, unknown>[] = [];
  const citations = [];
  for (const [outputIndex, item] of output.entries()) {
    if (item.type !== 'message') continue;
    for (const [contentIndex, block] of array(item.content)
      .map(object)
      .entries()) {
      if (block.type !== 'output_text') continue;
      content.push(block);
      for (const [annotationIndex, annotation] of array(block.annotations)
        .map(object)
        .entries()) {
        if (annotation.type !== 'url_citation') continue;
        // The provider's character unit is unverified. Retain local offsets with
        // their original block identity, rather than asserting a joined-answer span.
        citationProvenance.push({
          outputIndex,
          contentIndex,
          annotationIndex,
          startIndex: annotation.start_index ?? null,
          endIndex: annotation.end_index ?? null,
        });
        const normalized = citation({
          ...annotation,
          start_index: undefined,
          end_index: undefined,
        });
        if (normalized) citations.push(normalized);
      }
    }
  }
  const reportedUsage = object(raw.usage);
  const usage = {
    inputTokens: number(reportedUsage.input_tokens),
    outputTokens: number(reportedUsage.output_tokens),
    toolCalls: output.filter((item) => item.type === 'web_search_call').length,
  };
  const answerText = content.map((item) => text(item.text)).join('\n');
  const rawPayload = {
    response: response.json,
    metadata: {
      citationOffsetUnit: 'character-unverified',
      citationOffsetBasis: 'provider-text-block',
      citationProvenance,
    },
  };
  const requestId = text(raw.id) || response.headers.get('x-request-id');
  if (raw.status !== 'completed' || !answerText.trim())
    throw new PaidProviderError('unknown', {
      rawPayload: {
        ...rawPayload,
        metadata: { ...rawPayload.metadata, incomplete: true },
      },
      answerText,
      citations,
      usage,
      cost: estimateCost(request.model, usage),
      requestId,
      completedAt: new Date().toISOString(),
    });
  return result(
    request,
    rawPayload,
    answerText,
    citations,
    usage,
    started,
    requestId,
  );
}
