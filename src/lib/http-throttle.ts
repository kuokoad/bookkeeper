import type { Db } from '@/db/types';
import { rateLimit } from '@/lib/rate-limit';

/**
 * A ceiling on how often one signed-in person can ask for something expensive.
 *
 * ---------------------------------------------------------------------------
 * This is NOT the sign-in throttle, and it defends against a different thing.
 *
 * `clientThrottleKey` counts anonymous attempts, so it has no identity to work
 * with and has to fall back to a single shared bucket. Here the caller has
 * already been authenticated and authorised, so the key is their USER ID — an
 * identity the caller cannot forge, cannot rotate, and cannot share with the
 * next request. Every person therefore gets their own allowance, and one
 * runaway loop cannot deny the shop its own exports.
 *
 * The thing being defended is availability rather than secrecy. Building a
 * report scans the ledger and taking a backup copies and re-verifies the whole
 * database; either in a tight loop makes the till slow for everyone else on a
 * machine sitting under a shop counter. The limits below are set to catch a
 * loop, not a person: an owner working through month-end, changing the period
 * and downloading again, must never meet one.
 * ---------------------------------------------------------------------------
 */

export interface Throttle {
  /** How many requests are allowed inside the window. */
  limit: number;
  windowMs: number;
}

/**
 * Exports: generous. Somebody comparing months legitimately downloads a run of
 * these one after another, and being stopped mid-task would be worse than the
 * load it saves.
 */
export const EXPORT_THROTTLE: Throttle = { limit: 30, windowMs: 60_000 };

/**
 * Backups: tighter, because each one copies the entire database and verifies
 * it. A shop takes one at close of business; a handful covers retries and a
 * second copy onto a USB stick.
 */
export const BACKUP_THROTTLE: Throttle = { limit: 6, windowMs: 5 * 60_000 };

/**
 * `null` when the request may proceed, otherwise the 429 to return.
 *
 * `Retry-After` is in whole seconds and rounded UP: rounding down would invite
 * a retry that is still inside the window, which reads to the caller as the
 * limit lying to them.
 */
export function throttleOrNull(
  db: Db,
  key: string,
  { limit, windowMs }: Throttle,
  now: number = Date.now(),
): Response | null {
  const result = rateLimit(db, key, limit, windowMs, now);
  if (result.allowed) return null;

  const seconds = Math.ceil(result.retryAfterMs / 1000);
  return new Response(
    `That is more requests than this can serve at once. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    {
      status: 429,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': String(seconds),
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
