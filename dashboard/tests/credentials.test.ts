import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, scrypt } from 'node:crypto';
import { verifyCredentials } from '../src/lib/auth/credentials';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return {
    ...crypto,
    randomBytes: vi.fn(crypto.randomBytes),
    scrypt: vi.fn(crypto.scrypt),
  };
});

const username = 'fixture-operator';
const password = 'placeholder-password';

beforeEach(() => vi.clearAllMocks());

describe('operator credential verification', () => {
  it('accepts matching credentials using fresh salts on repeated checks', async () => {
    await expect(
      verifyCredentials(username, password, username, password),
    ).resolves.toBe(true);
    await expect(
      verifyCredentials(username, password, username, password),
    ).resolves.toBe(true);
    expect(randomBytes).toHaveBeenCalledTimes(2);
    expect(scrypt).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(scrypt).mock.calls;
    const firstSalt = calls[0]?.[1];
    const secondSalt = calls[2]?.[1];
    expect(Buffer.isBuffer(firstSalt)).toBe(true);
    expect((firstSalt as Buffer).length).toBeGreaterThanOrEqual(16);
    expect(calls[1]?.[1]).toBe(firstSalt);
    expect(calls[3]?.[1]).toBe(secondSalt);
    expect(firstSalt).not.toEqual(secondSalt);
  });

  it.each([
    ['wrong username', 'fixture-other', password],
    ['wrong password with valid username', username, 'placeholder-passwore'],
    ['different password length', username, 'placeholder-password-extra'],
    ['leading username space', ` ${username}`, password],
    ['trailing password space', username, `${password} `],
  ])(
    'rejects %s and still derives both passwords',
    async (_label, user, pass) => {
      await expect(
        verifyCredentials(user, pass, username, password),
      ).resolves.toBe(false);
      expect(scrypt).toHaveBeenCalledTimes(2);
    },
  );

  it('supports exact Unicode credentials without normalization', async () => {
    const user = 'fixture-оператор-🔑';
    const pass = 'placeholder-café-🔒';
    await expect(verifyCredentials(user, pass, user, pass)).resolves.toBe(true);
    await expect(
      verifyCredentials(user, pass.normalize('NFD'), user, pass),
    ).resolves.toBe(false);
  });

  it.each([
    ['appended NUL', 'placeholder-password\0'],
    ['embedded NUL', 'placeholder\0password'],
    ['lone high surrogate', 'placeholder-\uD800'],
    ['lone low surrogate', 'placeholder-\uDC00'],
  ])(
    'rejects %s in every credential before deriving',
    async (_label, invalid) => {
      for (const index of [0, 1, 2, 3]) {
        const values: [string, string, string, string] = [
          username,
          password,
          username,
          password,
        ];
        values[index] = invalid;
        await expect(verifyCredentials(...values)).resolves.toBe(false);
      }
      expect(scrypt).not.toHaveBeenCalled();
    },
  );

  it('rejects a trailing NUL password alias for a valid password', async () => {
    await expect(
      verifyCredentials(username, `${password}\0`, username, password),
    ).resolves.toBe(false);
    expect(scrypt).not.toHaveBeenCalled();
  });

  it('rejects lone surrogates that would alias literal replacement characters', async () => {
    const replacementUser = 'fixture-\uFFFD';
    const replacementPassword = 'placeholder-\uFFFD';
    await expect(
      verifyCredentials(
        replacementUser,
        replacementPassword,
        replacementUser,
        replacementPassword,
      ),
    ).resolves.toBe(true);
    vi.mocked(scrypt).mockClear();
    await expect(
      verifyCredentials(
        'fixture-\uD800',
        replacementPassword,
        replacementUser,
        replacementPassword,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyCredentials(
        replacementUser,
        'placeholder-\uDC00',
        replacementUser,
        replacementPassword,
      ),
    ).resolves.toBe(false);
    expect(scrypt).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3])(
    'rejects empty credential argument %s before deriving',
    async (index) => {
      const values: [string, string, string, string] = [
        username,
        password,
        username,
        password,
      ];
      values[index] = '';
      await expect(verifyCredentials(...values)).resolves.toBe(false);
      expect(scrypt).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1, 2, 3])(
    'rejects oversized credential argument %s before deriving',
    async (index) => {
      const values: [string, string, string, string] = [
        username,
        password,
        username,
        password,
      ];
      values[index] = 'x'.repeat(1025);
      await expect(verifyCredentials(...values)).resolves.toBe(false);
      expect(scrypt).not.toHaveBeenCalled();
    },
  );
});
