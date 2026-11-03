import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ExecutionStatusChip,
  executionStatuses,
} from '../src/components/execution-status-chip';
import {
  ExtractionStatusChip,
  extractionStatuses,
} from '../src/components/extraction-status-chip';
import {
  IntegrationChip,
  integrationStatuses,
} from '../src/components/integration-chip';
import { CitationChip, citationLabels } from '../src/components/citation-chip';
import { AutoRefresh } from '../src/components/auto-refresh';
import { EmptyState, ErrorState, LoadingTable } from '../src/components/states';
import {
  formatDuration,
  formatCost,
  formatCount,
  formatTimestamp,
} from '../src/lib/format/values';
import { QuestionForm } from '../src/app/(console)/executions/new/question-form';
import { KeyForm } from '../src/app/(console)/settings/keys/key-form';
const { refresh, submitQuestion, saveKey } = vi.hoisted(() => ({
  refresh: vi.fn(),
  submitQuestion: vi.fn(async () => ({ results: [] })),
  saveKey: vi.fn(async () => ({ message: 'Saved' })),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('../src/app/(console)/executions/new/actions', () => ({
  submitQuestion,
}));
vi.mock('../src/app/(console)/settings/keys/actions', () => ({ saveKey }));
describe('operator presentation and controls', () => {
  it('maps every execution, extraction, integration and citation state', () => {
    for (const value of Object.keys(
      executionStatuses,
    ) as (keyof typeof executionStatuses)[]) {
      const view = render(<ExecutionStatusChip value={value} />);
      expect(view.container.textContent).toBe(executionStatuses[value][0]);
      view.unmount();
    }
    for (const value of Object.keys(
      extractionStatuses,
    ) as (keyof typeof extractionStatuses)[]) {
      const view = render(<ExtractionStatusChip value={value} />);
      expect(view.container.textContent).toBe(extractionStatuses[value][0]);
      view.unmount();
    }
    for (const value of Object.keys(
      integrationStatuses,
    ) as (keyof typeof integrationStatuses)[]) {
      const view = render(<IntegrationChip value={value} />);
      expect(view.container.textContent).toBe(integrationStatuses[value][0]);
      view.unmount();
    }
    for (const value of Object.keys(
      citationLabels,
    ) as (keyof typeof citationLabels)[]) {
      const view = render(<CitationChip value={value} />);
      expect(view.container.textContent).toBe(citationLabels[value]);
      view.unmount();
    }
  });
  it('formats unknowns, four-decimal USD, durations, counts and explicit timezone', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(92000)).toBe('1:32');
    expect(formatDuration(null)).toBe('—');
    expect(formatCost(0.0123)).toBe('$0.0123');
    expect(formatCost(null)).toBe('—');
    expect(formatCount(1284)).toBe('1,284');
    expect(formatTimestamp('2026-11-02T00:00:00Z')).toMatch(/GMT|UTC/);
  });
  it('stops refresh when all executions are terminal and while hidden', () => {
    vi.useFakeTimers();
    const view = render(<AutoRefresh statuses={['queued']} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(
      <AutoRefresh statuses={['succeeded', 'dead', 'unknown_outcome']} />,
    );
    act(() => vi.advanceTimersByTime(10000));
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(<AutoRefresh statuses={['running']} />);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(refresh).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
  });
  it('distinguishes loading, empty, no-match and safe error states', () => {
    const view = render(<LoadingTable />);
    expect(
      screen.getByLabelText('Loading executions').getAttribute('aria-busy'),
    ).toBe('true');
    view.rerender(<EmptyState />);
    expect(screen.getByText('No executions yet')).not.toBeNull();
    view.rerender(<EmptyState filtered />);
    expect(
      screen.getByText('No executions match these filters'),
    ).not.toBeNull();
    view.rerender(<ErrorState requestId="request-1" />);
    expect(screen.getByRole('alert').textContent).toContain('request-1');
  });
  it('requires an explicit paid-rerun confirmation before forced submission', async () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    const user = userEvent.setup();
    render(<QuestionForm />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByLabelText('Force a new run today'));
    fireEvent.submit(
      screen.getByRole('button', { name: 'Ask question' }).closest('form')!,
    );
    expect(screen.getByRole('dialog').textContent).toContain(
      'counts against the spend cap',
    );
    expect(submitQuestion).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
  });
  it('clears the uncontrolled provider-key input before calling the server action', async () => {
    const user = userEvent.setup();
    const view = render(<KeyForm provider="openai" />);
    const input = screen.getByLabelText(
      'Temporary API key',
    ) as HTMLInputElement;
    await user.type(input, 'placeholder-key-not-for-real-services');
    await user.click(
      screen.getByRole('button', { name: 'Save temporary key' }),
    );
    expect(input.value).toBe('');
    expect(view.container.innerHTML).not.toContain(
      'placeholder-key-not-for-real-services',
    );
    expect(saveKey).toHaveBeenCalledTimes(1);
  });
});
