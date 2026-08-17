/**
 * In-memory fixed-window rate limiter.
 *
 * Sufficient for a local-first single-process deployment, which is what this
 * app is. It is a second line of defence in front of per-account lockout: the
 * account lock stops guessing at one user, this stops a script working through
 * many usernames from one machine.
 *
 * If the app is ever moved behind multiple processes this must become shared
 * state — noted here so the limitation is not discovered by surprise.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

/** Stop the map growing without bound on a long-running server. */
const MAX_TRACKED_KEYS = 10_000;

function sweep(now: number): void {
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  if (buckets.size > MAX_TRACKED_KEYS) sweep(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterMs: 0 };
}

/** Clear a bucket after a successful attempt. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Test-only: wipe all state. */
export function __resetAllRateLimits(): void {
  buckets.clear();
}
