import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import * as schema from '@/db/schema';
import { configureConnection } from '@/db/pragmas';
import type { Db } from '@/db/types';
import { purgeExpiredRateLimits, rateLimit, resetRateLimit } from '@/lib/rate-limit';

/**
 * The sign-in throttle, and why it lives in the database.
 *
 * It used to be a `Map` in process memory, which meant an attacker's counter
 * was cleared by anything that restarted the server — a deploy, a power cut,
 * the nightly reboot — and was invisible to any second process. The tests that
 * matter here are the ones about surviving those things; the arithmetic is the
 * easy half.
 */

const KEY = 'login:shared';
const LIMIT = 5;
const WINDOW = 15 * 60 * 1000;
const T0 = 1_770_000_000_000;

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => context.cleanup());

describe('counting attempts in a window', () => {
  it('allows exactly the limit, then refuses', () => {
    for (let attempt = 1; attempt <= LIMIT; attempt++) {
      const result = rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
      expect(result.allowed, `attempt ${attempt}`).toBe(true);
      expect(result.remaining).toBe(LIMIT - attempt);
    }

    const blocked = rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBe(WINDOW);
  });

  it('does not extend the window when it refuses', () => {
    // Otherwise someone who keeps trying is chasing a deadline that never
    // arrives, and an honest person locked out by a typo waits for ever.
    for (let attempt = 0; attempt < LIMIT; attempt++) rateLimit(context.db, KEY, LIMIT, WINDOW, T0);

    const first = rateLimit(context.db, KEY, LIMIT, WINDOW, T0 + 1_000);
    const later = rateLimit(context.db, KEY, LIMIT, WINDOW, T0 + 60_000);

    expect(first.allowed).toBe(false);
    expect(later.allowed).toBe(false);
    // The deadline is the same instant both times, just closer.
    expect(T0 + 1_000 + first.retryAfterMs).toBe(T0 + 60_000 + later.retryAfterMs);
  });

  it('starts again once the window has passed', () => {
    for (let attempt = 0; attempt < LIMIT; attempt++) rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
    expect(rateLimit(context.db, KEY, LIMIT, WINDOW, T0).allowed).toBe(false);

    const afterWindow = rateLimit(context.db, KEY, LIMIT, WINDOW, T0 + WINDOW + 1);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(LIMIT - 1);
  });

  it('counts each key separately', () => {
    for (let attempt = 0; attempt < LIMIT; attempt++) rateLimit(context.db, KEY, LIMIT, WINDOW, T0);

    expect(rateLimit(context.db, KEY, LIMIT, WINDOW, T0).allowed).toBe(false);
    expect(rateLimit(context.db, 'login:1.2.3.4', LIMIT, WINDOW, T0).allowed).toBe(true);
  });
});

describe('signing in successfully', () => {
  it('clears the counter, so a later typo does not lock the till', () => {
    for (let attempt = 0; attempt < LIMIT - 1; attempt++) {
      rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
    }

    resetRateLimit(context.db, KEY);

    const fresh = rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(LIMIT - 1);
  });
});

describe('surviving what emptied the old one', () => {
  /**
   * The whole point of the change. A second handle to the same file stands in
   * for the restarted process, the redeploy, or the forked worker — none of
   * which would have seen a counter held in memory.
   */
  function reopen(): { db: Db; close: () => void } {
    const connection = new Database(context.connection.name);
    configureConnection(connection);
    return { db: drizzle(connection, { schema }) as Db, close: () => connection.close() };
  }

  it('a restart does not hand back a fresh allowance', () => {
    for (let attempt = 0; attempt < LIMIT; attempt++) rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
    expect(rateLimit(context.db, KEY, LIMIT, WINDOW, T0).allowed).toBe(false);

    const restarted = reopen();
    try {
      // A `Map` would be empty here, and the attacker would carry on counting
      // from nothing.
      expect(rateLimit(restarted.db, KEY, LIMIT, WINDOW, T0).allowed).toBe(false);
    } finally {
      restarted.close();
    }
  });

  it('two processes share one allowance rather than one each', () => {
    const second = reopen();
    try {
      // Split the attempts between them; together they should still only get
      // the limit.
      for (let attempt = 0; attempt < 3; attempt++) rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
      for (let attempt = 0; attempt < 2; attempt++) rateLimit(second.db, KEY, LIMIT, WINDOW, T0);

      expect(rateLimit(second.db, KEY, LIMIT, WINDOW, T0).allowed).toBe(false);
      expect(rateLimit(context.db, KEY, LIMIT, WINDOW, T0).allowed).toBe(false);
    } finally {
      second.close();
    }
  });
});

describe('housekeeping', () => {
  it('drops buckets whose window has closed', () => {
    rateLimit(context.db, 'login:a', LIMIT, WINDOW, T0);
    rateLimit(context.db, 'login:b', LIMIT, WINDOW, T0);

    const removed = purgeExpiredRateLimits(context.db, T0 + WINDOW + 1);
    expect(removed).toBe(2);

    const rows = context.connection
      .prepare('SELECT COUNT(*) AS c FROM rate_limits')
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('leaves a live bucket alone', () => {
    rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
    expect(purgeExpiredRateLimits(context.db, T0 + 1_000)).toBe(0);
    expect(rateLimit(context.db, KEY, LIMIT, WINDOW, T0 + 1_000).remaining).toBe(LIMIT - 2);
  });

  it('does not accumulate a row per attempt', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      rateLimit(context.db, KEY, LIMIT, WINDOW, T0);
    }
    const rows = context.connection
      .prepare('SELECT COUNT(*) AS c FROM rate_limits')
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });
});
