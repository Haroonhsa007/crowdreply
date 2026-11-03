'use client';
import { useSyncExternalStore } from 'react';
import { formatTimestamp } from '@/lib/format/values';
const subscribe = () => () => {};
export function LocalTime({ value }: { value: string }) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return (
    <time className="num" dateTime={value} title={value}>
      {hydrated
        ? formatTimestamp(value)
        : value.replace('T', ' ').replace('Z', ' UTC')}
    </time>
  );
}
