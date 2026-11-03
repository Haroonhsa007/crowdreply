import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const APPLICATION_SALT = 'crowdreply-provider-key-v1';
export function keyCipher(secret: string) {
  const key = scryptSync(secret, APPLICATION_SALT, 32);
  return {
    encrypt(value: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        body.toString('base64url'),
      ].join('.');
    },
    decrypt(value: string): string | null {
      try {
        const [version, iv, tag, body, extra] = value.split('.');
        if (version !== 'v1' || !iv || !tag || !body || extra !== undefined)
          return null;
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(iv, 'base64url'),
        );
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(body, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}
