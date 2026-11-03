import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
const hash = (value: string) => createHash('sha256').update(value).digest();
export function verifyCredentials(
  username: string,
  password: string,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  const userValid = timingSafeEqual(hash(username), hash(expectedUsername));
  const passwordValid = timingSafeEqual(hash(password), hash(expectedPassword));
  return userValid && passwordValid;
}
export function loginLimiter(clock: () => number = Date.now) {
  let failures = 0;
  let resetAt = 0;
  return {
    permitted() {
      if (clock() >= resetAt) failures = 0;
      return failures < 5;
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
