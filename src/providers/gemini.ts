import {
  normalizeDomain,
  type Citation,
  type ProviderRequest,
} from '../contracts/index.js';
import { array, number, object, requestJson, text } from './http.js';
import { result, type LiveOptions } from './normalize.js';
import { PaidProviderError } from './paid-error.js';
import { estimateCost } from './pricing.js';

export async function executeGemini(
  request: ProviderRequest,
  options: LiveOptions,
  signal: AbortSignal,
) {
  const started = new Date().toISOString();
  const response = await requestJson({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`,
    headers: { 'x-goog-api-key': options.apiKey },
    body: {
      contents: [{ role: 'user', parts: [{ text: request.questionText }] }],
      generationConfig: { maxOutputTokens: 1024 },
      ...(request.settings.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
    },
    signal,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
  });
  const raw = object(response.json);
  const candidate = object(array(raw.candidates)[0]);
  const grounding = object(candidate.groundingMetadata);
  const chunks = array(grounding.groundingChunks).map(object);
  const parts = array(object(candidate.content).parts).map((part) =>
    text(object(part).text),
  );
  const answerText = parts.join('\n');
  const partByteStarts = parts.map((_, index) =>
    Buffer.byteLength(
      parts.slice(0, index).join('\n') + (index ? '\n' : ''),
      'utf8',
    ),
  );
  const supports = array(grounding.groundingSupports).map(object);
  const citations: Citation[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const web = object(chunks[i]?.web);
    const url = text(web.uri);
    const title = text(web.title);
    try {
      normalizeDomain(url);
      // Titles are reported bare domains; do not follow redirect URLs or invent a destination.
      const domain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)
        ? normalizeDomain(`https://${title}`)
        : 'unknown';
      const matches = supports.filter((item) =>
        array(item.groundingChunkIndices).includes(i),
      );
      for (const support of matches.length ? matches : [{}]) {
        const segment = object(support.segment);
        // Single-part responses omit partIndex; multipart spans need explicit provenance.
        const partIndex =
          number(segment.partIndex) ?? (parts.length === 1 ? 0 : null);
        const start = number(segment.startIndex);
        const end = number(segment.endIndex);
        const valid =
          partIndex !== null &&
          Number.isInteger(partIndex) &&
          parts[partIndex] !== undefined &&
          start !== null &&
          end !== null &&
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start <= end &&
          end <= Buffer.byteLength(parts[partIndex]!, 'utf8');
        citations.push({
          url,
          domain,
          ...(title ? { title } : {}),
          ...(valid
            ? {
                startIndex: partByteStarts[partIndex!]! + start!,
                endIndex: partByteStarts[partIndex!]! + end!,
              }
            : {}),
        });
      }
    } catch {
      /* Invalid provider URLs are excluded; the complete response is still preserved. */
    }
  }
  const reportedUsage = object(raw.usageMetadata);
  const usage = {
    inputTokens: number(reportedUsage.promptTokenCount),
    outputTokens: number(reportedUsage.candidatesTokenCount),
    toolCalls: Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries.length
      : null,
  };
  const rawPayload = {
    response: response.json,
    metadata: {
      citationOffsetUnit: 'utf8-bytes',
      citationOffsetBasis: 'joined-answer',
      groundingSupports: supports,
    },
  };
  const requestId = text(raw.responseId) || null;
  // Missing/unknown termination cannot prove completion any more than a safety
  // block or exhausted output budget. Keep all received paid evidence for review.
  if (candidate.finishReason !== 'STOP' || !answerText.trim())
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
    citations.length ? 'yes' : Object.keys(grounding).length ? 'no' : 'unknown',
  );
}
