import {
  ProviderError,
  type Citation,
  type ProviderRequest,
} from '../contracts/index.js';
import {
  array,
  number,
  object,
  ProviderResponseError,
  requestJson,
  text,
} from './http.js';
import { citation, result, type LiveOptions } from './normalize.js';
import { PaidProviderError } from './paid-error.js';
import { estimateCost } from './pricing.js';

const MAX_CONTINUATIONS = 3;
export async function executeAnthropic(
  request: ProviderRequest,
  options: LiveOptions,
  signal: AbortSignal,
) {
  const started = new Date().toISOString();
  const responses: unknown[] = [];
  const messages: { role: string; content: unknown }[] = [
    { role: 'user', content: request.questionText },
  ];
  let raw: Record<string, unknown> = {};
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  let toolCalls: number | null = 0;
  const contents: Record<string, unknown>[] = [];
  try {
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const response = await requestJson({
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': options.apiKey,
          'anthropic-version': options.anthropicVersion,
        },
        body: {
          model: options.model,
          max_tokens: 512,
          messages,
          ...(request.settings.webSearch
            ? {
                tools: [
                  {
                    type: 'web_search_20250305',
                    name: 'web_search',
                    max_uses: 1,
                  },
                ],
              }
            : {}),
        },
        signal,
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
      });
      raw = object(response.json);
      responses.push(response.json);
      const blocks = array(raw.content).map(object);
      contents.push(...blocks);
      const usage = object(raw.usage);
      const searches = object(usage.server_tool_use);
      const add = (a: number | null, b: unknown) =>
        a === null || number(b) === null ? null : a + Number(b);
      inputTokens = add(inputTokens, usage.input_tokens);
      outputTokens = add(outputTokens, usage.output_tokens);
      toolCalls = add(toolCalls, searches.web_search_requests);
      const searchError = blocks
        .flatMap((block) => [
          block,
          object(block.content),
          ...array(block.content).map(object),
        ])
        .find((block) => block.type === 'web_search_tool_result_error');
      if (searchError) {
        const code = text(searchError.error_code);
        const retryable = ['too_many_requests', 'unavailable'].includes(code);
        throw new ProviderError({
          category:
            code === 'too_many_requests'
              ? 'rate_limit'
              : retryable
                ? 'server'
                : 'invalid_request',
          retryable,
          message: 'Provider search failed',
        });
      }
      if (raw.stop_reason !== 'pause_turn') {
        // This request configures neither client tools nor stop sequences. Only
        // end_turn establishes completion; token/context limits and unrecognized
        // termination remain incomplete paid evidence requiring reconciliation.
        if (raw.stop_reason !== 'end_turn')
          throw new ProviderError({
            category: 'unknown',
            retryable: false,
            message: 'Provider response did not complete',
          });
        break;
      }
      if (turn === MAX_CONTINUATIONS)
        throw new ProviderError({
          category: 'unknown',
          retryable: false,
          message: 'Provider continuation limit reached',
        });
      messages.push({ role: 'assistant', content: raw.content });
    }
    const citations = anthropicCitations(contents);
    return result(
      request,
      { responses, metadata: { citationOffsetUnit: 'none' } },
      contents
        .filter((block) => block.type === 'text')
        .map((block) => text(block.text))
        .join('\n'),
      citations,
      { inputTokens, outputTokens, toolCalls },
      started,
      text(raw.id) || null,
    );
  } catch (error) {
    if (!responses.length) throw error;
    const failure = error instanceof ProviderError ? error : null;
    const usage = { inputTokens, outputTokens, toolCalls };
    throw new PaidProviderError(failure?.category ?? 'unknown', {
      rawPayload: {
        responses,
        metadata: { citationOffsetUnit: 'none', incomplete: true },
        failure: {
          category: failure?.category ?? 'unknown',
          httpStatus: failure?.httpStatus ?? null,
          response:
            error instanceof ProviderResponseError ? error.rawPayload : null,
        },
      },
      answerText: contents
        .filter((block) => block.type === 'text')
        .map((block) => text(block.text))
        .join('\n'),
      citations: anthropicCitations(contents),
      usage,
      cost: estimateCost(request.model, usage),
      requestId: text(raw.id) || null,
      completedAt: new Date().toISOString(),
    });
  }
}

function anthropicCitations(contents: Record<string, unknown>[]): Citation[] {
  return contents
    .flatMap((block) => array(block.citations).map(object))
    .filter((item) => item.type === 'web_search_result_location')
    .map(citation)
    .filter((v) => v !== null);
}
