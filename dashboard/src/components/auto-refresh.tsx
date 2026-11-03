'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ExecutionStatus, ExtractionStatus } from '@contracts';
export function shouldRefresh(
  statuses: ExecutionStatus[],
  extractionStatuses: ExtractionStatus[] = [],
): boolean {
  return (
    statuses.some((status) =>
      ['queued', 'running', 'retry_wait'].includes(status),
    ) ||
    extractionStatuses.some((status) =>
      ['pending', 'extracting'].includes(status),
    )
  );
}
export function AutoRefresh({
  statuses,
  extractionStatuses = [],
}: {
  statuses: ExecutionStatus[];
  extractionStatuses?: ExtractionStatus[];
}) {
  const router = useRouter();
  const active = shouldRefresh(statuses, extractionStatuses);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return (
    <span className="muted">
      {active ? 'Updates every 5 seconds' : 'No pending work is visible'}
    </span>
  );
}
