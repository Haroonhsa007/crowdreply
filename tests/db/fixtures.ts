import {
  CreateExecutionInputSchema,
  type ProviderResult,
} from '../../src/contracts/index.js';
export const executionInput = CreateExecutionInputSchema.parse({
  questionId: 'q1',
  questionText: 'Best CRM?',
  questionVersion: 1,
  provider: 'openai',
  model: 'synthetic-model',
  modelSettingsVersion: 'v1',
  runDate: '2026-11-02',
  settings: { webSearch: true },
});
export const syntheticResult: ProviderResult = {
  provider: 'openai',
  integration: 'live',
  model: 'synthetic-model',
  rawPayload: { synthetic: true },
  answerText: 'Synthetic answer',
  citations: [],
  citationsAvailable: 'no',
  usage: { inputTokens: 1, outputTokens: 2, toolCalls: 1 },
  cost: { tokensUsd: 0.001, toolsUsd: 0.01, totalUsd: 0.011 },
  latencyMs: 5,
  requestId: 'synthetic-request',
  startedAt: '2026-11-02T00:00:00Z',
  completedAt: '2026-11-02T00:00:01Z',
};
