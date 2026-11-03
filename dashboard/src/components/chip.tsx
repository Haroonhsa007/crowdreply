export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export function Chip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className="chip" data-tone={tone}>
      {label}
    </span>
  );
}
