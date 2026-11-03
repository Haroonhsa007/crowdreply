import 'server-only';
import { z } from 'zod';
import type { DashboardEnv } from '../env';
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super('The API request could not be completed.');
  }
}
export function createApiClient(
  config: DashboardEnv,
  transport: typeof fetch = fetch,
) {
  return async function call<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: string; body?: unknown; correlationId?: string } = {},
  ): Promise<{ data: T; created: boolean }> {
    let response: Response;
    try {
      response = await transport(new URL(path, config.API_BASE_URL), {
        method: options.method ?? 'GET',
        headers: {
          'x-api-key': config.OPERATOR_API_KEY,
          'content-type': 'application/json',
          ...(options.correlationId
            ? { 'x-correlation-id': options.correlationId }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(503, 'unavailable', null);
    }
    const id = response.headers.get('x-correlation-id');
    if (!response.ok)
      throw new ApiError(
        response.status,
        response.status === 401 ? 'unauthorized' : 'request_failed',
        id,
      );
    try {
      const value: unknown = await response.json();
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ApiError(502, 'invalid_response', id);
      return { data: parsed.data, created: response.status === 201 };
    } catch {
      throw new ApiError(502, 'invalid_response', id);
    }
  };
}
