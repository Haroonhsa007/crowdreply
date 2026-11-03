import 'server-only';
import { ApiError } from './client';
export async function loadResource<T>(
  load: () => Promise<T>,
): Promise<
  | { ok: true; data: T; updatedAt: string }
  | { ok: false; requestId: string | null; unauthorized: boolean }
> {
  try {
    return {
      ok: true,
      data: await load(),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      requestId: error instanceof ApiError ? error.requestId : null,
      unauthorized: error instanceof ApiError && error.status === 401,
    };
  }
}
