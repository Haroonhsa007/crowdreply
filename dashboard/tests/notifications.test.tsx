import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, within } from '@testing-library/react';
import { createCloudlet } from '@cloudlet/toast';
import { ApiExecutionViewSchema } from '../../src/contracts';
import { useActionNotice } from '../src/lib/forms/use-action-notice';
import { ExecutionTable } from '../src/components/execution-table';

const { controller, state } = vi.hoisted(() => ({
  controller: {
    show: vi.fn(),
    update: vi.fn(),
    dismiss: vi.fn(),
    track: vi.fn(),
    cancel: vi.fn(),
  },
  state: { available: true },
}));
vi.mock('@cloudlet/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudlet/toast')>()),
  useOptionalCloudlet: () => (state.available ? controller : null),
}));
const issuer = createCloudlet();
const admission = issuer.show({ title: 'Fixture notification' });
if (admission.status === 'rejected')
  throw new Error('Fixture admission failed');
const handle = admission.handle;
issuer.dispose();

beforeEach(() => {
  state.available = true;
  for (const method of Object.values(controller)) method.mockReset();
  controller.show.mockReturnValue({ status: 'created', handle });
});

describe('form action notices', () => {
  it.each(['created', 'deduplicated'])(
    'retains the admitted handle when loading is %s',
    (status) => {
      controller.show.mockReturnValue({ status, handle, occurrences: 2 });
      const { result } = renderHook(useActionNotice);
      expect(result.current.begin('Saving access')).toBe(handle);
      expect(controller.show).toHaveBeenCalledWith({
        title: 'Saving access',
        kind: 'loading',
        attention: 'stack',
        announcementPriority: 'off',
      });
    },
  );

  it('handles rejected admission without inventing a handle', () => {
    controller.show.mockReturnValue({ status: 'rejected', reason: 'capacity' });
    const { result } = renderHook(useActionNotice);
    expect(result.current.begin('Saving access')).toBeNull();
    result.current.finish(null, { title: 'Access saved' });
    expect(controller.update).not.toHaveBeenCalled();
    expect(controller.show).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Access saved',
        kind: 'success',
        duration: 6000,
      }),
    );
  });

  it('updates the same loading handle with a bounded success and sticky error', () => {
    const { result } = renderHook(useActionNotice);
    const started = result.current.begin('Saving access');
    result.current.finish(started, {
      title: 'Access saved',
      description: 'Available for one hour.',
    });
    expect(controller.update).toHaveBeenLastCalledWith(handle, {
      title: 'Access saved',
      kind: 'success',
      duration: 6000,
      description: { kind: 'text', text: 'Available for one hour.' },
      attention: 'stack',
      announcementPriority: 'off',
    });
    result.current.finish(started, {
      title: 'Could not save access',
      error: true,
    });
    expect(controller.update).toHaveBeenLastCalledWith(handle, {
      title: 'Could not save access',
      kind: 'error',
      duration: null,
      attention: 'stack',
      announcementPriority: 'off',
    });
    expect(controller.show).toHaveBeenCalledTimes(1);
    expect(controller.track).not.toHaveBeenCalled();
    expect(controller.cancel).not.toHaveBeenCalled();
    expect(controller.dismiss).not.toHaveBeenCalled();
  });

  it('is safe without a notification owner and leaves form work to its caller', () => {
    state.available = false;
    const { result } = renderHook(useActionNotice);
    expect(result.current.begin('Saving access')).toBeNull();
    expect(() => result.current.finish(null, { title: 'Saved' })).not.toThrow();
    expect(() =>
      result.current.finish(handle, { title: 'Failed', error: true }),
    ).not.toThrow();
    for (const method of Object.values(controller))
      expect(method).not.toHaveBeenCalled();
  });
});

describe('answer list presentation', () => {
  it('offers the next action for each result and keeps technical facts in a disclosure', () => {
    const statuses = [
      'queued',
      'running',
      'retry_wait',
      'succeeded',
      'dead',
      'unknown_outcome',
    ] as const;
    const items = statuses.map((status) =>
      ApiExecutionViewSchema.parse({
        id: `synthetic-answer-${status}`,
        executionKey: 'a'.repeat(64),
        questionText: `Fixture question for ${status}?`,
        provider: 'openai',
        integration: 'mock',
        model: 'synthetic-model',
        status,
        extractionStatus: 'pending',
        citationsAvailable: 'unknown',
        attemptCount: 0,
        createdAt: '2026-11-02T00:00:00.000Z',
      }),
    );
    render(<ExecutionTable items={items} />);
    const rows = within(
      screen.getByRole('list', { name: 'Provider answers' }),
    ).getAllByRole('listitem');
    expect(rows).toHaveLength(statuses.length);
    rows.forEach((row, index) => {
      const item = items[index]!;
      const action =
        item.status === 'succeeded'
          ? 'Read answer'
          : ['dead', 'unknown_outcome'].includes(item.status)
            ? 'Review issue'
            : 'View progress';
      expect(
        within(row).getByRole('link', { name: action }).getAttribute('href'),
      ).toBe(`/executions/${item.id}`);
      expect(
        within(row).getByRole('link', { name: item.questionText }),
      ).not.toBeNull();
      const details = within(row).getByText(item.model).closest('details')!;
      expect(details.open).toBe(false);
      expect(details.textContent).toContain('Estimated cost');
      expect(within(row).getByLabelText('Latency unknown').textContent).toBe(
        '—',
      );
      expect(
        within(row).getByLabelText('Estimated cost unknown').textContent,
      ).toBe('—');
    });
  });
});
