import { Chip } from './chip';
export const citationLabels = {
  yes: 'Citations available',
  no: 'Citations not available',
  unknown: 'Citations unknown',
} satisfies Record<'yes' | 'no' | 'unknown', string>;
export function CitationChip({
  value,
}: {
  value: keyof typeof citationLabels;
}) {
  return <Chip label={citationLabels[value]} tone="neutral" />;
}
