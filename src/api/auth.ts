import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function apiKeyAuth(expected: string): RequestHandler {
  const expectedHash = createHash('sha256').update(expected).digest();
  return (req, res, next) => {
    const receivedHash = createHash('sha256')
      .update(req.get('x-api-key') ?? '')
      .digest();
    if (!timingSafeEqual(expectedHash, receivedHash)) {
      res
        .status(401)
        .json({ error: 'Unauthorized', correlationId: req.correlationId });
      return;
    }
    next();
  };
}
