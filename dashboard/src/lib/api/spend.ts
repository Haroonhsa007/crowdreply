import 'server-only';
import { z } from 'zod';
import { createApiClient } from './client';
import { env } from '../env';
const schema = z
  .object({
    totalUsd: z.number().nonnegative().nullable(),
    capUsd: z.number().positive(),
    remainingUsd: z.number().nonnegative().nullable(),
  })
  .strict();
export async function spend() {
  return (await createApiClient(env())('/spend', schema)).data;
}
