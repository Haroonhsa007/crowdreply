import 'server-only';
import { headers } from 'next/headers';
import {
  ApiExecutionListResponseSchema,
  ApiExecutionViewSchema,
  ApiSubmitRequestSchema,
} from '@contracts';
import { createApiClient } from './client';
import { env } from '../env';
export async function executions(query: Record<string, string> = {}) {
  return (
    await createApiClient(env())(
      `/executions?${new URLSearchParams(query)}`,
      ApiExecutionListResponseSchema,
      { correlationId: (await headers()).get('x-correlation-id') ?? undefined },
    )
  ).data;
}
export async function execution(id: string) {
  return (
    await createApiClient(env())(
      `/executions/${encodeURIComponent(id)}?raw=1`,
      ApiExecutionViewSchema,
    )
  ).data;
}
export async function submitExecution(input: unknown) {
  return createApiClient(env())('/executions', ApiExecutionViewSchema, {
    method: 'POST',
    body: ApiSubmitRequestSchema.parse(input),
  });
}
