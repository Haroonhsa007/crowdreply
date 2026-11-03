import type { ExtractionStatus } from '@contracts';
import { Chip, type Tone } from './chip';
export const extractionStatuses = {
  not_applicable: ['Not run', 'neutral'],
  pending: ['Pending', 'neutral'],
  extracting: ['Extracting', 'info'],
  extracted: ['Extracted', 'success'],
  extraction_failed: ['Extraction failed', 'danger'],
} satisfies Record<ExtractionStatus, [string, Tone]>;
export function ExtractionStatusChip({ value }: { value: ExtractionStatus }) {
  const [label, tone] = extractionStatuses[value];
  return <Chip label={label} tone={tone} />;
}
