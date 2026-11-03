import type { IntegrationStatus } from '@contracts';
import { Chip, type Tone } from './chip';
export const integrationStatuses = {
  live: ['Live', 'success'],
  mock: ['Mock', 'warning'],
  not_integrated: ['Not integrated', 'neutral'],
} satisfies Record<IntegrationStatus, [string, Tone]>;
export function IntegrationChip({ value }: { value?: IntegrationStatus }) {
  const [label, tone] = value
    ? integrationStatuses[value]
    : (['Not run yet', 'neutral'] as const);
  return <Chip label={label} tone={tone} />;
}
