import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import pino, { type Bindings, type DestinationStream, type Logger } from 'pino';
import type { Config } from '../config/index.js';

const sensitive = new Set([
  'authorization',
  'apikey',
  'password',
  'operator_api_key',
  'openai_api_key',
  'mongodb_uri',
  'redis_url',
  'x-api-key',
  'x-goog-api-key',
  'operator_username',
  'operator_password',
  'session_secret',
  'mongo_root_username',
  'mongo_root_password',
  'redis_password',
  'key_encryption_secret',
  'perplexity_api_key',
  'gemini_api_key',
  'anthropic_api_key',
]);

function sanitize(
  value: unknown,
  secrets: string[],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string')
    return secrets.reduce((s, key) => s.split(key).join('[REDACTED]'), value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error)
    return { type: value.name, message: 'Operation failed' };
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitive.has(key.toLowerCase())
        ? '[REDACTED]'
        : sanitize(item, secrets, seen),
    ]),
  );
}

export function createLogger(
  config: Config,
  destination?: DestinationStream,
): Logger {
  const secrets = Object.entries(config)
    .filter(([key]) => sensitive.has(key.toLowerCase()))
    .map(([, value]) => value)
    .filter((v): v is string => Boolean(v));
  const options: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'authorization',
        'apiKey',
        'password',
        'OPERATOR_API_KEY',
        'OPENAI_API_KEY',
        'headers.authorization',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    // Recursion covers arbitrary depth; message arguments also mask configured secret values.
    hooks: {
      logMethod(args, method) {
        const safe = args.map((arg) => sanitize(arg, secrets)) as Parameters<
          typeof method
        >;
        method.apply(this, safe);
      },
    },
    // Root bindings bypass logMethod, so sanitize them separately.
    formatters: {
      bindings: (bindings) =>
        sanitize(bindings, secrets) as Record<string, unknown>,
    },
  };
  const protectBindings = <Levels extends string>(
    instance: Logger<Levels>,
  ): Logger<Levels> => {
    // Pino resets the bindings formatter for children; sanitize before its child API.
    const child = instance.child.bind(instance);
    instance.child = <ChildLevels extends string = never>(
      bindings: Bindings,
      childOptions?: pino.ChildLoggerOptions<ChildLevels>,
    ) =>
      protectBindings(
        child<ChildLevels>(
          sanitize(bindings, secrets) as Bindings,
          childOptions,
        ),
      );
    const setBindings = instance.setBindings.bind(instance);
    instance.setBindings = (bindings) =>
      setBindings(sanitize(bindings, secrets) as Bindings);
    return instance;
  };
  return protectBindings(
    destination ? pino(options, destination) : pino(options),
  );
}

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      log: Logger;
    }
  }
}

export function correlationMiddleware(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-correlation-id');
    const correlationId =
      incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();
    req.correlationId = correlationId;
    req.log = logger.child({ correlationId });
    res.setHeader('x-correlation-id', correlationId);
    const started = performance.now();
    // Do not log URL/query strings, headers or request bodies.
    req.log.info(
      { event: 'request.start', method: req.method },
      'Request started',
    );
    res.once('finish', () =>
      req.log.info(
        {
          event: 'request.finish',
          method: req.method,
          statusCode: res.statusCode,
          durationMs: performance.now() - started,
        },
        'Request finished',
      ),
    );
    next();
  };
}
