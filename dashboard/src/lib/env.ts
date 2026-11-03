import 'server-only';
import { z } from 'zod';
const schema = z.object({
  OPERATOR_USERNAME: z.string().min(3),
  OPERATOR_PASSWORD: z.string().min(12),
  OPERATOR_API_KEY: z.string().min(16),
  SESSION_SECRET: z.string().min(32),
  API_BASE_URL: z.string().url().default('http://127.0.0.1:3000'),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
});
export type DashboardEnv = z.infer<typeof schema>;
export function env(): DashboardEnv {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success)
    throw new Error(
      `Invalid dashboard configuration fields: ${parsed.error.issues.map((i) => String(i.path[0])).join(', ')}`,
    );
  return parsed.data;
}
