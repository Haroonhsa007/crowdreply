import 'server-only';
import {
  ExtractionDetailSchema,
  VisibilityResponseSchema,
} from '../../../../src/contracts/extraction-api';
import { createApiClient } from './client';
import { env } from '../env';
export type { ExtractionDetail } from '../../../../src/contracts/extraction-api';
export async function extraction(id: string) {
  return (
    await createApiClient(env())(
      `/executions/${encodeURIComponent(id)}/extraction`,
      ExtractionDetailSchema,
    )
  ).data;
}
export async function visibility(query: Record<string, string> = {}) {
  return (
    await createApiClient(env())(
      `/visibility?${new URLSearchParams(query)}`,
      VisibilityResponseSchema,
    )
  ).data;
}
