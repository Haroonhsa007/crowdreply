export interface WorkerHealthState {
  draining: boolean;
  recovered: boolean;
  isRunning(): boolean;
}

/** Bounded readiness, distinct from process liveness; never return error values. */
export async function workerReady(
  state: WorkerHealthState,
  checks: { mongo(): Promise<void>; redis(): Promise<void> },
  timeoutMs = 1000,
): Promise<boolean> {
  if (state.draining || !state.recovered || !state.isRunning()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([checks.mongo(), checks.redis()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Readiness timed out')),
          timeoutMs,
        );
      }),
    ]);
    return !state.draining && state.recovered && state.isRunning();
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
