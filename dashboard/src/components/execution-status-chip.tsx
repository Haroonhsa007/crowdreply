import type { ExecutionStatus } from '@contracts';
import { Chip, type Tone } from './chip';
export const executionStatuses = {
  queued: ['Queued', 'neutral'],
  running: ['Running', 'info'],
  retry_wait: ['Retrying', 'warning'],
  succeeded: ['Succeeded', 'success'],
  dead: ['Dead-lettered', 'danger'],
  unknown_outcome: ['Unknown outcome', 'warning'],
} satisfies Record<ExecutionStatus, [string, Tone]>;
export function ExecutionStatusChip({ value }: { value: ExecutionStatus }) {
  const [label, tone] = executionStatuses[value];
  return <Chip label={label} tone={tone} />;
}
