import { describe, expect, it } from 'vitest';
import {
  assertPasswordAcceptable,
  assertPinAcceptable,
  hashPassword,
  hashPin,
  needsRehash,
  verifyPassword,
} from '@/lib/auth/password';
import { ValidationError } from '@/domain/errors';

describe('hashPassword / verifyPassword', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('kwame-shop-2026');
    await expect(verifyPassword('kwame-shop-2026', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('kwame-shop-2026');
    await expect(verifyPassword('kwame-shop-2027', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('never stores the password in the hash', async () => {
    const password = 'my-secret-passphrase';
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
    expect(hash.toLowerCase()).not.toContain('secret');
  });

  it('produces a different hash each time (unique salt)', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
    // Both still verify.
    await expect(verifyPassword('same-password-here', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password-here', b)).resolves.toBe(true);
  });

  it('encodes algorithm and parameters alongside the hash', async () => {
    const hash = await hashPassword('kwame-shop-2026');
    const [algorithm, n, r, p] = hash.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(32_768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(hash.split('$')).toHaveLength(6);
  });

  it('handles unicode passwords consistently', async () => {
    const hash = await hashPassword('Adwoa-Ɔsɛe-2026');
    await expect(verifyPassword('Adwoa-Ɔsɛe-2026', hash)).resolves.toBe(true);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    for (const corrupt of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$1$2$3$abc$def', 'scrypt$99$8$1$YWJj$ZGVm']) {
      await expect(verifyPassword('anything', corrupt), corrupt).resolves.toBe(false);
    }
  });

  it('refuses tampered parameters that would exhaust memory', async () => {
    // N far beyond policy — a poisoned database row must not become a DoS.
    const malicious = 'scrypt$99999999$8$1$YWJjZGVmZ2hpamtsbW5vcA$ZGVm';
    await expect(verifyPassword('anything', malicious)).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a freshly created hash', async () => {
    expect(needsRehash(await hashPassword('kwame-shop-2026'))).toBe(false);
  });

  it('is true for weaker parameters and for junk', async () => {
    expect(needsRehash('scrypt$16384$8$1$YWJj$ZGVm')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('password policy', () => {
  it('accepts a reasonable password', () => {
    expect(() => assertPasswordAcceptable('kwame-shop-2026')).not.toThrow();
  });

  it('rejects short, common and degenerate passwords', () => {
    expect(() => assertPasswordAcceptable('short1')).toThrow(ValidationError);
    expect(() => assertPasswordAcceptable('password123')).toThrow(ValidationError);
    expect(() => assertPasswordAcceptable('PASSWORD123')).toThrow(ValidationError);
    expect(() => assertPasswordAcceptable('aaaaaaaaaa')).toThrow(ValidationError);
    expect(() => assertPasswordAcceptable('x'.repeat(201))).toThrow(ValidationError);
  });
});

describe('PIN handling', () => {
  it('hashes and verifies a PIN', async () => {
    const hash = await hashPin('8351');
    await expect(verifyPassword('8351', hash)).resolves.toBe(true);
    await expect(verifyPassword('8352', hash)).resolves.toBe(false);
  });

  it('rejects weak PINs', () => {
    expect(() => assertPinAcceptable('1111')).toThrow(ValidationError);
    expect(() => assertPinAcceptable('1234')).toThrow(ValidationError);
    expect(() => assertPinAcceptable('4321')).toThrow(ValidationError);
    expect(() => assertPinAcceptable('12')).toThrow(ValidationError);
    expect(() => assertPinAcceptable('123456789')).toThrow(ValidationError);
    expect(() => assertPinAcceptable('12a4')).toThrow(ValidationError);
  });

  it('accepts a non-obvious PIN', () => {
    expect(() => assertPinAcceptable('8351')).not.toThrow();
    expect(() => assertPinAcceptable('905172')).not.toThrow();
  });
});
