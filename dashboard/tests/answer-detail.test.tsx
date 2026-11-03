import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiExecutionViewSchema } from '../../src/contracts';
import DetailPage from '../src/app/(console)/executions/[id]/page';

const { execution, extraction, refresh } = vi.hoisted(() => ({
  execution: vi.fn(),
  extraction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../src/lib/api/executions', () => ({ execution }));
vi.mock('../src/lib/api/extraction', () => ({ extraction }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const item = ApiExecutionViewSchema.parse({
  id: 'fixture-execution-id',
  executionKey: 'a'.repeat(64),
  questionText: 'Which CRM fits a small sales team?',
  provider: 'openai',
  integration: 'mock',
  model: 'fixture-model',
  status: 'succeeded',
  extractionStatus: 'extracted',
  citationsAvailable: 'yes',
  attemptCount: 1,
  createdAt: '2026-11-03T12:00:00Z',
  raw: {
    outputText:
      'HubSpot CRM is one option. Compare its capabilities with your team’s needs.',
    citations: [
      { url: 'https://hubspot.com/', domain: 'hubspot.com', title: 'HubSpot' },
    ],
    providerResponseId: 'fixture-provider-response',
  },
});
const page = () => DetailPage({ params: Promise.resolve({ id: item.id }) });

beforeEach(() => {
  execution.mockReset();
  extraction.mockReset();
  refresh.mockReset();
  execution.mockResolvedValue(structuredClone(item));
  extraction.mockResolvedValue({
    current: null,
    history: [],
    historyLimit: 20,
  });
});

describe('answer detail', () => {
  it('leads with the question and saved provider answer while disclosing technical identifiers separately', async () => {
    const user = userEvent.setup();
    render(await page());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      item.questionText,
    );
    expect(
      screen
        .getByRole('link', { name: '← Back to answers' })
        .getAttribute('href'),
    ).toBe('/executions');
    expect(
      screen.getByRole('heading', { name: 'Provider answer' }),
    ).not.toBeNull();
    expect(screen.getByText(item.raw!.outputText)).not.toBeNull();
    expect(screen.getByText('Mock')).not.toBeNull();
    expect(
      screen.getByText(/simulated answers, not live provider responses/),
    ).not.toBeNull();
    const technical = screen.getByText(item.id).closest('details')!;
    expect(technical.open).toBe(false);
    expect(technical.contains(screen.getByText(item.model))).toBe(true);
    expect(technical.contains(screen.getByText(item.executionKey))).toBe(true);
    await user.click(
      screen.getByText('Technical details', { selector: 'summary' }),
    );
    expect(technical.open).toBe(true);
    const citation = screen.getByRole('link', { name: 'hubspot.com' });
    expect(citation.getAttribute('href')).toBe('https://hubspot.com/');
    expect(citation.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('heading', { name: 'Brands' })).not.toBeNull();
    expect(screen.getAllByLabelText('unknown').length).toBeGreaterThan(0);
  });

  it('explains a pending provider answer and continues automatic refresh', async () => {
    execution.mockResolvedValue({
      ...item,
      status: 'running',
      raw: undefined,
      citationsAvailable: 'unknown',
    });
    vi.useFakeTimers();
    render(await page());
    expect(
      screen.getByRole('heading', {
        name: 'Waiting for the provider’s answer',
      }),
    ).not.toBeNull();
    expect(screen.getByText(/Source links will appear/)).not.toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the possible paid outcome explicit and does not refresh or offer an automatic retry', async () => {
    execution.mockResolvedValue({
      ...item,
      status: 'unknown_outcome',
      extractionStatus: 'not_applicable',
      raw: undefined,
    });
    vi.useFakeTimers();
    render(await page());
    expect(screen.getByText(/provider may have charged/).textContent).toContain(
      'Automatic retry is disabled',
    );
    expect(
      screen.getByRole('heading', {
        name: 'The result could not be confirmed',
      }),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    act(() => vi.advanceTimersByTime(10000));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('continues brand extraction updates after the provider answer has been saved', async () => {
    execution.mockResolvedValue({ ...item, extractionStatus: 'pending' });
    vi.useFakeTimers();
    render(await page());
    expect(screen.getByText(item.raw!.outputText)).not.toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a way back to answers when the answer cannot load without exposing upstream errors', async () => {
    execution.mockRejectedValue(
      new Error('placeholder-private-upstream-error'),
    );
    const view = render(await page());
    expect(
      screen.getByRole('heading', { name: 'Answer unavailable' }),
    ).not.toBeNull();
    expect(
      screen.getByRole('link', { name: '← Back to answers' }),
    ).not.toBeNull();
    expect(screen.getByRole('alert')).not.toBeNull();
    expect(view.container.textContent).not.toContain(
      'placeholder-private-upstream-error',
    );
  });
});
