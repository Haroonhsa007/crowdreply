import { z } from 'zod';
export const SESSION_COOKIE = 'crowdreply-session';
export const SESSION_SECONDS = 3600;
const payloadSchema = z
  .object({ sub: z.literal('operator'), exp: z.number().int() })
  .strict();
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const decode = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    (char) => char.charCodeAt(0),
  );
const key = (secret: string) =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
export async function signSession(
  secret: string,
  now = Date.now(),
): Promise<string> {
  const body = encode(
    new TextEncoder().encode(
      JSON.stringify({
        sub: 'operator',
        exp: Math.floor(now / 1000) + SESSION_SECONDS,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${encode(new Uint8Array(signature))}`;
}
export async function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!token || token.length > 2048 || secret.length < 32) return false;
  try {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra) return false;
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await key(secret),
        decode(signature),
        new TextEncoder().encode(body),
      ))
    )
      return false;
    const parsed = payloadSchema.safeParse(
      JSON.parse(new TextDecoder().decode(decode(body))),
    );
    return parsed.success && parsed.data.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}
