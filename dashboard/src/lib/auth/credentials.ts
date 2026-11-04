import 'server-only';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Bound work and allocations without trimming, truncating or normalizing credentials.
const MAX_CREDENTIAL_LENGTH = 1024;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function verifyCredentials(
  username: string,
  password: string,
  expectedUsername: string,
  expectedPassword: string,
): Promise<boolean> {
  if (
    [username, password, expectedUsername, expectedPassword].some(
      (value) =>
        value.length === 0 ||
        value.length > MAX_CREDENTIAL_LENGTH ||
        // NUL can alias scrypt's HMAC padding; lone surrogates alias U+FFFD
        // when encoded as UTF-8. Reject both rather than altering credentials.
        value.includes('\0') ||
        /[\uD800-\uDFFF]/u.test(value),
    )
  ) {
    return false;
  }
  const userBytes = Buffer.from(username, 'utf8');
  const expectedUserBytes = Buffer.from(expectedUsername, 'utf8');
  const userValid =
    userBytes.length === expectedUserBytes.length &&
    timingSafeEqual(userBytes, expectedUserBytes);
  // Derive both passwords even when the username is incorrect. A fresh salt is
  // shared only within this verification; credentials remain in server env config.
  const salt = randomBytes(16);
  const expectedKey = await derivePassword(expectedPassword, salt);
  const receivedKey = await derivePassword(password, salt);
  const passwordValid = timingSafeEqual(receivedKey, expectedKey);
  return userValid && passwordValid;
}

export function loginLimiter(clock: () => number = Date.now) {
  let failures = 0;
  let resetAt = 0;
  let inFlight = false;
  return {
    permitted() {
      if (clock() >= resetAt) failures = 0;
      return failures < 5;
    },
    acquire() {
      // Reserve synchronously before the first await so concurrent actions cannot
      // bypass the failure budget or queue unbounded password derivations.
      if (inFlight || !this.permitted()) return false;
      inFlight = true;
      return true;
    },
    release() {
      inFlight = false;
    },
    remainingSeconds() {
      if (failures < 5) return 0;
      return Math.max(0, Math.ceil((resetAt - clock()) / 1000));
    },
    failed() {
      if (!failures) resetAt = clock() + 300_000;
      failures++;
    },
    reset() {
      failures = 0;
      resetAt = 0;
    },
  };
}
