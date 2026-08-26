import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { BACKUP_THROTTLE, EXPORT_THROTTLE, throttleOrNull } from '@/lib/http-throttle';

/**
 * The ceiling on expensive requests from somebody already signed in.
 *
 * A different defence from the sign-in throttle, against a different thing.
 * Nothing here is secret — the caller has been authenticated and authorised.
 * What is at risk is the shop's own machine: building a report scans the
 * ledger and a backup copies and re-verifies the whole database, and either in
 * a loop makes the till unusable for everyone else.
 *
 * So the limits have to catch a runaway loop without ever meeting a person.
 * An owner working through month-end, changing the period and downloading
 * again, is the case that must not be stopped.
 */

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => context.cleanup());

describe('throttling an expensive request', () => {
  it('lets an ordinary run of exports straight through', () => {
    // Twelve in a burst is somebody comparing months, not an attack.
    for (let i = 0; i < 12; i++) {
      expect(throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE), `request ${i + 1}`).toBeNull();
    }
  });

  it('stops the run once past the limit', () => {
    for (let i = 0; i < EXPORT_THROTTLE.limit; i++) {
      expect(throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE)).toBeNull();
    }

    const blocked = throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });

  it('says how long to wait, rounded UP', () => {
    /**
     * Rounding down would name a moment still inside the window, so the caller
     * retries, is refused again, and learns the number is not to be trusted.
     */
    const now = 1_000_000;
    for (let i = 0; i < EXPORT_THROTTLE.limit; i++) {
      throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE, now);
    }

    // 1.5 seconds left in the window: the answer must be 2, never 1.
    const blocked = throttleOrNull(
      context.db,
      'export:1',
      EXPORT_THROTTLE,
      now + EXPORT_THROTTLE.windowMs - 1_500,
    )!;
    expect(blocked.headers.get('Retry-After')).toBe('2');
  });

  it('gives every person their own allowance', () => {
    // One runaway till must not stop the owner taking their own exports.
    for (let i = 0; i < EXPORT_THROTTLE.limit + 5; i++) {
      throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE);
    }
    expect(throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE)).not.toBeNull();
    expect(throttleOrNull(context.db, 'export:2', EXPORT_THROTTLE)).toBeNull();
  });

  it('keeps exports and backups in separate buckets', () => {
    for (let i = 0; i < BACKUP_THROTTLE.limit + 1; i++) {
      throttleOrNull(context.db, 'backup:1', BACKUP_THROTTLE);
    }
    expect(throttleOrNull(context.db, 'backup:1', BACKUP_THROTTLE)).not.toBeNull();
    // Being unable to take another backup must not stop them reading a report.
    expect(throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE)).toBeNull();
  });

  it('opens again once the window has passed', () => {
    const now = 2_000_000;
    for (let i = 0; i < EXPORT_THROTTLE.limit + 1; i++) {
      throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE, now);
    }
    expect(throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE, now)).not.toBeNull();

    expect(
      throttleOrNull(context.db, 'export:1', EXPORT_THROTTLE, now + EXPORT_THROTTLE.windowMs + 1),
    ).toBeNull();
  });

  it('allows a shop to take its backups without meeting the limit', () => {
    // One at close of business, a retry, and a second copy for the USB stick.
    for (let i = 0; i < 3; i++) {
      expect(throttleOrNull(context.db, 'backup:1', BACKUP_THROTTLE)).toBeNull();
    }
  });
});

describe('the routes actually use it', () => {
  /**
   * Read from the source, like the other structural checks. A helper nothing
   * calls is not a limit, which is the exact shape of the last defect found in
   * this codebase — five void actions that existed and were never reached.
   */
  const source = (path: string) => readFileSync(join(process.cwd(), 'src', 'app', 'api', path), 'utf8');

  it('throttles the report export, keyed on the person', () => {
    const route = source(join('reports', '[report]', 'route.ts'));
    expect(route).toContain('throttleOrNull');
    expect(route).toMatch(/export:\$\{actor\.id\}/);
  });

  it('throttles the backup download, keyed on the person', () => {
    const route = source(join('backup', 'route.ts'));
    expect(route).toContain('throttleOrNull');
    expect(route).toMatch(/backup:\$\{actor\.id\}/);
  });

  it('checks permission BEFORE spending anything on the throttle', () => {
    // An unauthenticated caller must be turned away by the cheaper check, and
    // must not be able to fill somebody else's bucket.
    for (const path of [join('reports', '[report]', 'route.ts'), join('backup', 'route.ts')]) {
      const route = source(path);
      expect(route.indexOf('requirePermission')).toBeLessThan(route.indexOf('throttleOrNull('));
    }
  });
});
