import { z } from 'zod';

const serviceUrl = (protocols: string[]) =>
  z
    .string()
    .min(1)
    .refine((value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    });
const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: serviceUrl(['mongodb:', 'mongodb+srv:']),
  REDIS_URL: serviceUrl(['redis:', 'rediss:']),
  OPERATOR_API_KEY: z.string().min(16),
  OPENAI_API_KEY: z.string().min(1).optional(),
  PERPLEXITY_API_KEY: z.string().min(8).optional(),
  GEMINI_API_KEY: z.string().min(8).optional(),
  ANTHROPIC_API_KEY: z.string().min(8).optional(),
  OPERATOR_USERNAME: z.string().min(3),
  OPERATOR_PASSWORD: z.string().min(12),
  SESSION_SECRET: z.string().min(32),
  MONGO_ROOT_USERNAME: z.string().min(1),
  MONGO_ROOT_PASSWORD: z.string().min(12),
  REDIS_PASSWORD: z.string().min(12),
  KEY_ENCRYPTION_SECRET: z.string().min(32),
  USER_KEY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .default(3600),
  OPENAI_MODEL: z.string().min(1).default('gpt-6-luna'),
  PERPLEXITY_MODEL: z.string().min(1).default('perplexity/sonar'),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  // Research disagrees on the version header; confirm on the first opt-in live call.
  ANTHROPIC_VERSION: z.string().min(1).default('2023-06-01'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(4),
  RETRY_BASE_MS: z.coerce.number().int().positive().default(2000),
  RETRY_MAX_MS: z.coerce.number().int().positive().default(60000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(20).default(1),
  LIVE_CALL_RESERVE_USD: z.coerce.number().positive().default(0.05),
  SPEND_CAP_USD: z.coerce.number().positive().max(2).default(2),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Config = z.infer<typeof schema>;

/** Configuration errors reveal field names only, never values or Zod issue payloads. */
export class ConfigError extends Error {
  constructor(fields: string[]) {
    super(
      `Invalid configuration fields: ${[...new Set(fields)].sort().join(', ')}`,
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new ConfigError(
      result.error.issues.map((i) => String(i.path[0] ?? 'environment')),
    );
  return result.data;
}

/** Startup diagnostics report presence, not credential values or misleading masked keys. */
export function redactedConfig(config: Config): Record<string, unknown> {
  const hidden = new Set([
    'OPERATOR_API_KEY',
    'OPERATOR_USERNAME',
    'OPERATOR_PASSWORD',
    'SESSION_SECRET',
    'MONGO_ROOT_USERNAME',
    'MONGO_ROOT_PASSWORD',
    'REDIS_PASSWORD',
    'KEY_ENCRYPTION_SECRET',
    'MONGODB_URI',
    'REDIS_URL',
    'OPENAI_API_KEY',
    'PERPLEXITY_API_KEY',
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(config).filter(([key]) => !hidden.has(key)),
    ),
    operatorApiKeyConfigured: Boolean(config.OPERATOR_API_KEY),
    operatorLoginConfigured: Boolean(
      config.OPERATOR_USERNAME && config.OPERATOR_PASSWORD,
    ),
    mongoUriConfigured: Boolean(config.MONGODB_URI),
    redisUrlConfigured: Boolean(config.REDIS_URL),
    sessionSecretConfigured: Boolean(config.SESSION_SECRET),
    keyEncryptionSecretConfigured: Boolean(config.KEY_ENCRYPTION_SECRET),
    providerKeysConfigured: {
      openai: Boolean(config.OPENAI_API_KEY),
      perplexity: Boolean(config.PERPLEXITY_API_KEY),
      gemini: Boolean(config.GEMINI_API_KEY),
      anthropic: Boolean(config.ANTHROPIC_API_KEY),
    },
  };
}
