import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ValidationError } from '@/domain/errors';

/**
 * Password and PIN hashing using scrypt from Node's standard library.
 *
 * scrypt is a memory-hard KDF accepted by OWASP for password storage. Choosing
 * it over argon2 avoids a native dependency, which matters because this app is
 * installed on a shop's own Windows PC where a failed node-gyp build would be a
 * support call nobody can answer.
 *
 * Passwords are NEVER stored, logged, or included in an error. Only the encoded
 * hash below is persisted.
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Current cost parameters. Raising N later is safe — see `needsRehash`. */
const PARAMS = {
  N: 32_768, // CPU/memory cost — 2^15
  r: 8, // block size
  p: 1, // parallelisation
} as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const ALGORITHM = 'scrypt';

// scrypt needs roughly 128 * N * r bytes; Node's default maxmem (32 MB) is below
// what these parameters require, so it is raised explicitly with headroom.
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

export const MIN_PASSWORD_LENGTH = 8;
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

function encode(salt: Buffer, hash: Buffer, params: typeof PARAMS): string {
  return [
    ALGORITHM,
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

interface DecodedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function decode(encoded: string): DecodedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6) return null;
  const [algorithm, n, r, p, salt, hash] = parts;
  if (algorithm !== ALGORITHM) return null;

  const parsedN = Number(n);
  const parsedR = Number(r);
  const parsedP = Number(p);
  if (!Number.isInteger(parsedN) || !Number.isInteger(parsedR) || !Number.isInteger(parsedP)) {
    return null;
  }
  // Refuse absurd parameters from a tampered database rather than attempting a
  // multi-gigabyte allocation.
  if (parsedN < 1024 || parsedN > 1_048_576 || parsedR < 1 || parsedR > 32 || parsedP < 1 || parsedP > 16) {
    return null;
  }

  const saltBytes = Buffer.from(salt ?? '', 'base64url');
  const hashBytes = Buffer.from(hash ?? '', 'base64url');

  /**
   * Both halves must be long enough to be real.
   *
   * `Buffer.from` does not throw on rubbish — it quietly drops what it cannot
   * decode, so a blank or corrupt hash portion becomes a ZERO-LENGTH buffer.
   * The derivation below takes its key length from that buffer, so a
   * zero-length stored hash derived a zero-length key, compared nothing against
   * nothing, and returned true: the account accepted ANY password, with a
   * record that still looked well-formed in the database. A truncated restore
   * or an interrupted write was enough to cause it.
   *
   * The bounds are deliberately loose rather than pinned to today's
   * `KEY_LENGTH`, so raising it later does not lock everyone out of hashes made
   * under the old one. `needsRehash` handles that upgrade properly.
   */
  const MIN_SALT_BYTES = 8;
  const MIN_HASH_BYTES = 16;
  const MAX_HASH_BYTES = 256;

  if (saltBytes.length < MIN_SALT_BYTES) return null;
  if (hashBytes.length < MIN_HASH_BYTES || hashBytes.length > MAX_HASH_BYTES) return null;

  return {
    N: parsedN,
    r: parsedR,
    p: parsedP,
    salt: saltBytes,
    hash: hashBytes,
  };
}

/** Hash a password for storage. Returns the full encoded string. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });
  return encode(salt, hash, PARAMS);
}

/** Hash a short numeric PIN. Same scheme; entropy is protected by lockout. */
export async function hashPin(pin: string): Promise<string> {
  assertPinAcceptable(pin);
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(pin, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEM });
  return encode(salt, hash, PARAMS);
}

/**
 * Verify a candidate against a stored hash.
 *
 * Always compares in constant time, and always performs the full derivation even
 * for a malformed stored hash, so response timing does not reveal whether an
 * account exists or how its record is shaped.
 */
export async function verifyPassword(candidate: string, encoded: string): Promise<boolean> {
  const decoded = decode(encoded);

  if (!decoded) {
    // Burn equivalent work so a missing/corrupt hash is not detectable by timing.
    await scryptAsync('', randomBytes(SALT_LENGTH), KEY_LENGTH, {
      ...PARAMS,
      maxmem: MAX_MEM,
    });
    return false;
  }

  const derived = await scryptAsync(candidate.normalize('NFKC'), decoded.salt, decoded.hash.length, {
    N: decoded.N,
    r: decoded.r,
    p: decoded.p,
    maxmem: 128 * decoded.N * decoded.r * 2,
  });

  // Belt and braces: `decode` already refuses a hash too short to be one, so
  // this can no longer be a zero-length comparison that trivially succeeds.
  if (derived.length === 0 || derived.length !== decoded.hash.length) return false;
  return timingSafeEqual(derived, decoded.hash);
}

/**
 * A hash produced with weaker parameters than the current policy.
 * Callers re-hash transparently on the next successful login.
 */
export function needsRehash(encoded: string): boolean {
  const decoded = decode(encoded);
  if (!decoded) return true;
  return decoded.N < PARAMS.N || decoded.r < PARAMS.r || decoded.p < PARAMS.p;
}

// --- policy ----------------------------------------------------------------

/** Rejected outright — these are the passwords actually used in the wild. */
const FORBIDDEN_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'shop1234',
  'admin123',
  'letmein1',
  'welcome1',
]);

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }
  if (password.length > 200) {
    throw new ValidationError('Password must be 200 characters or fewer.');
  }
  if (FORBIDDEN_PASSWORDS.has(password.toLowerCase())) {
    throw new ValidationError('That password is too common. Please choose a different one.');
  }
  if (/^(.)\1+$/.test(password)) {
    throw new ValidationError('Password cannot be the same character repeated.');
  }
}

export function assertPinAcceptable(pin: string): void {
  if (!/^\d+$/.test(pin)) {
    throw new ValidationError('PIN must contain digits only.');
  }
  if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
    throw new ValidationError(`PIN must be between ${MIN_PIN_LENGTH} and ${MAX_PIN_LENGTH} digits.`);
  }
  if (/^(\d)\1+$/.test(pin)) {
    throw new ValidationError('PIN cannot be the same digit repeated.');
  }
  if (/^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)/.test(pin)) {
    throw new ValidationError('PIN cannot be a simple sequence.');
  }
}
