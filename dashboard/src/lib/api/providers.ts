import 'server-only';
import {
  ApiProviderStatusListResponseSchema,
  ApiProviderStatusSchema,
  ApiSetProviderKeyRequestSchema,
  ProviderIdSchema,
} from '@contracts';
import { createApiClient } from './client';
import { env } from '../env';
export async function providers() {
  return (
    await createApiClient(env())(
      '/providers',
      ApiProviderStatusListResponseSchema,
    )
  ).data.items;
}
export async function setProviderKey(input: unknown) {
  const value = ApiSetProviderKeyRequestSchema.parse(input);
  return (
    await createApiClient(env())(
      `/providers/${value.provider}/key`,
      ApiProviderStatusSchema,
      { method: 'PUT', body: value },
    )
  ).data;
}
export async function removeProviderKey(provider: unknown) {
  return (
    await createApiClient(env())(
      `/providers/${ProviderIdSchema.parse(provider)}/key`,
      ApiProviderStatusSchema,
      { method: 'DELETE' },
    )
  ).data;
}
