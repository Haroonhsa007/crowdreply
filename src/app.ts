import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Logger } from 'pino';
import { correlationMiddleware } from './logging/index.js';
import { registerHealthRoutes, type DependencyChecks } from './health/index.js';

export interface AppOptions {
  logger: Logger;
  checks: DependencyChecks;
  /** CODEX-06 passes a route registrar here; mount before the foundation 404/error handlers. */
  registerRoutes?: (app: Express) => void;
}

export function createApp({ logger, checks, registerRoutes }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlationMiddleware(logger));
  app.use(express.json({ limit: '100kb' }));
  registerHealthRoutes(app, checks);
  registerRoutes?.(app);
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  const handleError: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    req.log.error({ event: 'request.error', err: error }, 'Request failed');
    if (res.headersSent) { res.end(); return; }
    const candidate = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
    const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate < 500 ? candidate : 500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request' });
  };
  app.use(handleError);
  return app;
}
