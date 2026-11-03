export function formatDuration(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function formatCost(value: number | null | undefined): string {
  return value == null ? '—' : `$${value.toFixed(4)}`;
}
export function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : new Intl.NumberFormat('en-US').format(value);
}
export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'longOffset',
  }).format(date);
}
export const providerNames = {
  openai: 'ChatGPT / OpenAI',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  anthropic: 'Claude',
  google_ai: 'Google AI search',
} as const;
