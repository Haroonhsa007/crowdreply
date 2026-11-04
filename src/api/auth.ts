import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function apiKeyAuth(expected: string): RequestHandler {
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (req, res, next) => {
    const receivedBytes = Buffer.from(req.get('x-api-key') ?? '', 'utf8');
    // High-entropy API keys are compared directly. Length may differ, but equal-
    // length contents are always compared in constant time; empty keys fail closed.
    if (
      expectedBytes.length === 0 ||
      expectedBytes.length !== receivedBytes.length ||
      !timingSafeEqual(expectedBytes, receivedBytes)
    ) {
      res
        .status(401)
        .json({ error: 'Unauthorized', correlationId: req.correlationId });
      return;
    }
    next();
  };
}
