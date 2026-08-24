import { eq, lte, sql } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { rateLimits } from '@/db/schema';

/**
 * Fixed-window rate limiter, kept in the database.
 *
 * ---------------------------------------------------------------------------
 * It used to be a `Map` in process memory, and that was wrong in two ways that
 * only show up in the deployment this application is actually for.
 *
 * Memory empties on every restart and every redeploy, so the counter an
 * attacker had run up was cleared by any of the things that restart a small
 * shop's server: a deploy, a power cut, a crash, the nightly reboot somebody
 * set up. And it is invisible to a second process, so the moment the app runs
 * under anything that forks workers, each worker hands out its own allowance.
 *
 * The per-account lockout in `users` is the primary defence and always was.
 * This is the layer in front of it, which stops one machine working through
 * MANY usernames — a thing per-account lockout cannot see.
 * ---------------------------------------------------------------------------
 *
 * The window is fixed rather than sliding: a bucket counts attempts until
 * `resetAt`, then starts again. Being blocked does not extend the window, so a
 * caller who keeps trying is not punished with an ever-receding deadline.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function rateLimit(
  db: Db,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  // Sign-in is not a hot path — a shop's till is opened a handful of times a
  // day — so the tidy-up rides along with the check rather than needing a
  // scheduler this deployment does not have.
  db.delete(rateLimits).where(lte(rateLimits.resetAt, new Date(now))).run();

  /**
   * One statement, so the read and the write cannot be separated.
   *
   * `attempts` climbs past the limit rather than stopping at it. That is
   * deliberate: it keeps this a single statement, and the answer is the same
   * either way, because `resetAt` is left alone once the window is running.
   */
  const row = db.get<{ attempts: number; reset_at: number }>(sql`
    INSERT INTO rate_limits (key, attempts, reset_at)
    VALUES (${key}, 1, ${now + windowMs})
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ${now} THEN 1 ELSE attempts + 1 END,
      reset_at = CASE WHEN reset_at <= ${now} THEN ${now + windowMs} ELSE reset_at END
    RETURNING attempts, reset_at
  `);

  const attempts = row?.attempts ?? 1;
  const resetAt = row?.reset_at ?? now + windowMs;
  const allowed = attempts <= limit;

  return {
    allowed,
    remaining: Math.max(0, limit - attempts),
    retryAfterMs: allowed ? 0 : Math.max(0, resetAt - now),
  };
}

/**
 * Clear a bucket after a successful attempt.
 *
 * Someone who signs in correctly has proved they are not the thing this is
 * defending against, and must not carry a near-full counter into their next
 * session — a mistyped password an hour later should not lock the till.
 */
export function resetRateLimit(db: Db, key: string): void {
  db.delete(rateLimits).where(eq(rateLimits.key, key)).run();
}

/** Housekeeping, exposed for tests and any future scheduled tidy-up. */
export function purgeExpiredRateLimits(db: Db, now: number = Date.now()): number {
  return db.delete(rateLimits).where(lte(rateLimits.resetAt, new Date(now))).run().changes;
}
