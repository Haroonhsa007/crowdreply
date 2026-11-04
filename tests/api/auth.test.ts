import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { apiKeyAuth } from '../../src/api/auth.js';

function authenticate(expected: string, received?: string) {
  const request = {
    get: (header: string) => (header === 'x-api-key' ? received : undefined),
    correlationId: 'fixture-request',
  } as unknown as Request;
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const next = vi.fn();
  apiKeyAuth(expected)(request, response as unknown as Response, next);
  return { response, next };
}

describe('API key authentication', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong same length', 'placeholder-api-kex'],
    ['same prefix shorter', 'placeholder-api-ke'],
    ['same prefix longer', 'placeholder-api-key-extra'],
    ['different unicode bytes', 'placeholder-api-kéy'],
  ])('rejects %s keys without returning key contents', (_label, received) => {
    const { response, next } = authenticate('placeholder-api-key', received);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledExactlyOnceWith(401);
    expect(response.json).toHaveBeenCalledExactlyOnceWith({
      error: 'Unauthorized',
      correlationId: 'fixture-request',
    });
  });

  it.each(['placeholder-api-key', 'placeholder-клю́ч-🔑'])(
    'accepts only the exact bytes of a configured key',
    (key) => {
      const { response, next } = authenticate(key, key);
      expect(next).toHaveBeenCalledExactlyOnceWith();
      expect(response.status).not.toHaveBeenCalled();
      expect(response.json).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', 'placeholder-api-key'])(
    'fails closed when the expected key is empty',
    (received) => {
      const { response, next } = authenticate('', received);
      expect(next).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledExactlyOnceWith(401);
    },
  );
});
