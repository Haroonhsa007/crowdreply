import {
  ProviderError,
  type ProviderErrorDetails,
} from '../contracts/index.js';

/** Redacted raw upstream errors are stored only as provider evidence, never logged. */
export class ProviderResponseError extends ProviderError {
  constructor(
    details: ProviderErrorDetails,
    readonly rawPayload: unknown,
  ) {
    super(details);
  }
}

const creditCodes = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'quota_exceeded',
  'enforced_spend_limit_reached',
  'insufficient_quota',
]);
export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
export interface HttpOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  fetch: typeof fetch;
}
/** Credentials may be echoed in otherwise useful provider evidence. Redact the
 * parsed strings and property names, not serialized JSON escape sequences.
 */
function credentialValues(headers: Record<string, string>): string[] {
  const values = Object.entries(headers).flatMap(([name, value]) => {
    const normalized = name.toLowerCase();
    if (normalized === 'authorization') {
      const token = /^\s*Bearer\s+(.+?)\s*$/i.exec(value)?.[1];
      return token ? [token] : [];
    }
    return ['x-api-key', 'x-goog-api-key'].includes(normalized) && value
      ? [value]
      : [];
  });
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}
function redactText(value: string, credentials: string[]): string {
  return credentials.reduce(
    (safe, credential) => safe.split(credential).join('[REDACTED]'),
    value,
  );
}
function redactJson(value: unknown, credentials: string[]): unknown {
  if (typeof value === 'string') return redactText(value, credentials);
  if (Array.isArray(value))
    return value.map((item) => redactJson(item, credentials));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(key, credentials),
        redactJson(item, credentials),
      ]),
    );
  return value;
}

export async function requestJson(
  options: HttpOptions,
): Promise<{ json: unknown; status: number; headers: Headers }> {
  const credentials = credentialValues(options.headers);
  try {
    const response = await options.fetch(options.url, {
      method: 'POST',
      // Provider credentials and paid request bodies must never follow redirects.
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(options.timeoutMs),
      ]),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = object(object(json).error);
      const code =
        text(error.code) || text(error.type) || text(object(json).code);
      const permanent = creditCodes.has(code) || response.status === 402;
      const category =
        permanent || [401, 403].includes(response.status)
          ? 'auth'
          : response.status === 429
            ? 'rate_limit'
            : response.status === 408
              ? 'timeout'
              : response.status >= 500
                ? 'server'
                : 'invalid_request';
      throw new ProviderResponseError(
        {
          category,
          httpStatus: response.status,
          retryable:
            !permanent &&
            ['rate_limit', 'timeout', 'server'].includes(category),
          retryAfterMs: retryAfter(response.headers.get('retry-after')),
          message: 'Provider request failed',
        },
        redactJson(json, credentials),
      );
    }
    if (json === null)
      throw new ProviderError({
        category: 'unknown',
        retryable: false,
        message: 'Invalid provider response',
      });
    // Request IDs can be persisted by adapters, so reflected credentials in
    // returned header values require the same protection as parsed JSON.
    const safeHeaders = new Headers(response.headers);
    safeHeaders.forEach((value, name) =>
      safeHeaders.set(name, redactText(value, credentials)),
    );
    return {
      json: redactJson(json, credentials),
      status: response.status,
      headers: safeHeaders,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timeout =
      error instanceof Error &&
      ['TimeoutError', 'AbortError'].includes(error.name);
    throw new ProviderError({
      category: timeout ? 'timeout' : 'server',
      retryable: !options.signal.aborted,
      message: 'Provider transport failed',
    });
  }
}
