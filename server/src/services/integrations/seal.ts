import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { deriveKey } from '../../auth/session';

// Secrets the server must read back (webhook signing secrets, connected-app tokens), encrypted with AES-256-GCM. The
// key is derived from JWT_SECRET for this purpose; changing JWT_SECRET makes them unreadable, and endpoints and
// connections then have to be set up again (they fail closed, never with a wrong secret). "bindTo" (the row's id) is
// authenticated, so a value copied to another row does not open.

const key = () => deriveKey('integration-secrets-v1');

export function seal(bindTo: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(bindTo));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['s1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(bindTo: string, sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 's1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(bindTo));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
