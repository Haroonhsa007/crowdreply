import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExecutionViewSchema } from '@contracts';
import { submitQuestion } from '../src/app/(console)/executions/new/actions';
import { ApiError } from '../src/lib/api/client';
const { submitExecution, requireSession, revalidatePath } = vi.hoisted(() => ({
  submitExecution: vi.fn(),
  revalidatePath: vi.fn(),
  requireSession: vi.fn(async () => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('../src/lib/auth/require-session', () => ({ requireSession }));
vi.mock('../src/lib/api/executions', () => ({ submitExecution }));
const accepted = ApiExecutionViewSchema.parse({
  id: 'synthetic-accepted',
  executionKey: 'a'.repeat(64),
  questionText: 'Best CRM?',
  provider: 'openai',
  model: 'synthetic-model',
  status: 'queued',
  extractionStatus: 'pending',
  citationsAvailable: 'unknown',
  attemptCount: 0,
  createdAt: '2026-11-02T00:00:00.000Z',
});
function form(providers: string[], force = false) {
  const data = new FormData();
  data.set('questionText', 'Best CRM?');
  for (const provider of providers) data.append('providers', provider);
  if (force) {
    data.set('force', 'on');
    data.set('forceConfirmed', 'yes');
  }
  return data;
}
beforeEach(() => {
  submitExecution.mockReset();
  revalidatePath.mockReset();
});
describe('submission reconciliation', () => {
  it('requires reconciliation after an uncertain forced submission', async () => {
    submitExecution.mockRejectedValueOnce(
      new ApiError(503, 'unavailable', null),
    );
    const state = await submitQuestion({}, form(['openai'], true));
    expect(state.results).toEqual([]);
    expect(state.error).toContain('Check Executions before trying again');
    expect(state.error).toContain('another paid execution');
    expect(state.error).not.toContain('safely submit again');
    expect(submitExecution).toHaveBeenCalledTimes(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it('preserves accepted results and stops after a later provider fails', async () => {
    submitExecution.mockResolvedValueOnce({ data: accepted, created: true });
    submitExecution.mockRejectedValueOnce(
      new ApiError(503, 'unavailable', 'request-1'),
    );
    const state = await submitQuestion(
      {},
      form(['openai', 'gemini', 'anthropic'], true),
    );
    expect(state.results).toEqual([{ item: accepted, created: true }]);
    expect(state.error).toContain('Some submissions were accepted');
    expect(state.error).toContain('Check Executions before trying again');
    expect(state.error).toContain('Request request-1');
    expect(submitExecution).toHaveBeenCalledTimes(2);
    expect(revalidatePath.mock.calls).toEqual([['/'], ['/executions']]);
  });
  it('validates all providers before accepting any submissions', async () => {
    const state = await submitQuestion({}, form(['openai', 'invalid']));
    expect(state.error).toContain('select valid providers');
    expect(submitExecution).not.toHaveBeenCalled();
    expect(requireSession).toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it('refreshes home and answer history once after successful accepted submissions', async () => {
    const second = {
      ...accepted,
      id: 'synthetic-gemini',
      provider: 'gemini' as const,
    };
    submitExecution.mockResolvedValueOnce({ data: accepted, created: true });
    submitExecution.mockResolvedValueOnce({ data: second, created: true });
    const state = await submitQuestion({}, form(['openai', 'gemini']));
    expect(state).toEqual({
      results: [
        { item: accepted, created: true },
        { item: second, created: true },
      ],
    });
    expect(submitExecution).toHaveBeenCalledTimes(2);
    expect(revalidatePath.mock.calls).toEqual([['/'], ['/executions']]);
  });
  it('refreshes returned existing runs without creating another execution', async () => {
    submitExecution.mockResolvedValueOnce({ data: accepted, created: false });
    const state = await submitQuestion({}, form(['openai']));
    expect(state).toEqual({ results: [{ item: accepted, created: false }] });
    expect(submitExecution).toHaveBeenCalledTimes(1);
    expect(revalidatePath.mock.calls).toEqual([['/'], ['/executions']]);
  });
});
