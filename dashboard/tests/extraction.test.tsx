import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ExtractionDetail } from '../src/lib/api/extraction';
import { BrandExtraction } from '../src/app/(console)/executions/[id]/brand-extraction';
import { AutoRefresh } from '../src/components/auto-refresh';
import { ExtractionSchema } from '../../src/contracts/extraction';
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const current = ExtractionSchema.parse({
  id: 'synthetic-extraction',
  executionId: 'synthetic-execution',
  extractorVersion: 'rules-v1-initial',
  algorithmVersion: 'rule-based-v1',
  method: 'rule_based',
  status: 'extracted',
  provider: 'openai',
  integration: 'mock',
  runDate: '2026-11-02',
  createdAt: '2026-11-02T00:00:00.000Z',
  mentions: [
    {
      brand: 'HubSpot',
      alias: 'HubSpot CRM',
      position: 1,
      mentionCount: 2,
      ambiguous: false,
      ambiguityReason: null,
      sourceSpan: { startIndex: 0, endIndex: 11, text: 'HubSpot CRM' },
      confidence: 0.95,
      citationIndexes: [0],
    },
    {
      brand: 'Close',
      alias: 'Close',
      position: null,
      mentionCount: 1,
      ambiguous: true,
      ambiguityReason: 'This occurrence lacks clear brand context.',
      sourceSpan: { startIndex: 12, endIndex: 17, text: 'Close' },
      confidence: 0.25,
      citationIndexes: [],
    },
  ],
  citedDomains: ['hubspot.com'],
});
const detail: ExtractionDetail = {
  current,
  history: [current],
  historyLimit: 20,
};
describe('brand evidence and extraction refresh', () => {
  it('shows aliases, rank, ambiguity, version, Mock provenance and supported citation links', () => {
    render(
      <BrandExtraction
        detail={detail}
        status="extracted"
        citations={[{ url: 'https://hubspot.com/', domain: 'hubspot.com' }]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Brands' })).not.toBeNull();
    expect(screen.getByText('HubSpot CRM')).not.toBeNull();
    expect(screen.getByText('rules-v1-initial')).not.toBeNull();
    expect(screen.getByText('Mock')).not.toBeNull();
    expect(screen.getByText(/Ambiguous:/)).not.toBeNull();
    expect(screen.getByLabelText('unknown')).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'hubspot.com' }).getAttribute('rel'),
    ).toBe('noopener noreferrer');
    expect(screen.getByText(/excluded from live visibility/)).not.toBeNull();
  });
  it('distinguishes unstarted, queued, failed and empty completed extraction states', () => {
    const view = render(
      <BrandExtraction
        detail={{ current: null, history: [], historyLimit: 20 }}
        status="pending"
      />,
    );
    expect(screen.getByText(/Extraction has not run/)).not.toBeNull();
    view.rerender(
      <BrandExtraction
        detail={{
          ...detail,
          current: { ...current, status: 'pending', mentions: [] },
        }}
        status="pending"
      />,
    );
    expect(screen.getByText(/queued or running/)).not.toBeNull();
    view.rerender(
      <BrandExtraction
        detail={{
          ...detail,
          current: {
            ...current,
            status: 'extraction_failed',
            mentions: [],
            error: {
              code: 'raw_unavailable',
              message:
                'The stored raw response is no longer available for extraction.',
            },
          },
        }}
        status="extraction_failed"
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'raw response is no longer available',
    );
    view.rerender(
      <BrandExtraction
        detail={{ ...detail, current: { ...current, mentions: [] } }}
        status="extracted"
      />,
    );
    expect(screen.getByText(/No supported brand mentions/)).not.toBeNull();
  });
  it('refreshes a succeeded execution while extraction is pending and stops at either terminal extraction state', () => {
    vi.useFakeTimers();
    const view = render(
      <AutoRefresh statuses={['succeeded']} extractionStatuses={['pending']} />,
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(
      <AutoRefresh
        statuses={['succeeded']}
        extractionStatuses={['extracting']}
      />,
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(refresh).toHaveBeenCalledTimes(2);
    view.rerender(
      <AutoRefresh
        statuses={['succeeded']}
        extractionStatuses={['extracted', 'extraction_failed']}
      />,
    );
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
