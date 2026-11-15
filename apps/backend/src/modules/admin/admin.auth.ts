/**
 * Admin authentication: password hashing, session tokens and the role check.
 *
 * Design constraints, all enforced here:
 *
 * - no API key ever ships to a browser: the public frontend has no admin
 *   credential of any kind;
 * - passwords are stored as `scrypt` hashes with a random salt and compared in
 *   constant time;
 * - sessions are opaque random tokens whose SHA-256 is what the database stores,
 *   so a database leak does not yield usable sessions;
 * - the bootstrap token exists only to create the first administrator and is
 *   never stored.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function createSessionToken(): { token: string; tokenSha256: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenSha256: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison for a presented secret against a stored digest. */
export function secretMatches(presented: string, expectedSha256: string | undefined): boolean {
  if (!expectedSha256) return false;
  const actual = Buffer.from(sha256(presented), 'hex');
  const expected = Buffer.from(expectedSha256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type AdminRole = 'editor' | 'admin';

/** Bootstrap is allowed only while there is no enabled administrator. */
export function canBootstrap(adminCount: number): boolean {
  return adminCount === 0;
}
