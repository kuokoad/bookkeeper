import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  UPDATE_STALE_AFTER_MS,
  checkForUpdates,
  readUpdateStatus,
  updateUnsupportedReason,
  type UpdateStatus,
} from '@/services/update.service';

/**
 * The owner's "Check for updates" and what the Health page says about the last
 * update. The update itself is a PowerShell script that stops the server, so it
 * is not run here; these are the parts that decide what the owner is told.
 */

let dir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(cwd: string, file: string, message: string): void {
  writeFileSync(join(cwd, file), message);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookkeeper-update-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Real git processes: several seconds each on Windows, more under the full suite's load.
const GIT_TIMEOUT = 60_000;

describe('checking for updates', { timeout: GIT_TIMEOUT }, () => {
  let shop: string;
  let developer: string;

  beforeEach(() => {
    const origin = join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    developer = join(dir, 'developer');
    git(dir, 'clone', '-q', origin, developer);
    commit(developer, 'a.txt', 'First release');
    git(developer, 'push', '-q', 'origin', 'main');
    shop = join(dir, 'shop');
    git(dir, 'clone', '-q', origin, shop);
  }, GIT_TIMEOUT);

  it('says the shop is on the newest version when nothing has been released since', async () => {
    const result = await checkForUpdates(shop);
    expect(result).toEqual({ ok: true, upstream: 'origin/main', changes: [] });
  });

  it('lists what has been released since, newest first', async () => {
    commit(developer, 'b.txt', 'Receipts show the tax number');
    commit(developer, 'c.txt', 'Fix: stock count after a return');
    git(developer, 'push', '-q', 'origin', 'main');

    const result = await checkForUpdates(shop);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map((change) => change.subject)).toEqual([
      'Fix: stock count after a return',
      'Receipts show the tax number',
    ]);
  });

  it('explains instead of failing when the copy was not installed with git clone', async () => {
    const loose = join(dir, 'loose');
    git(dir, 'init', '-q', '-b', 'main', loose);
    commit(loose, 'a.txt', 'Copied by hand');

    const result = await checkForUpdates(loose);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/git clone/);
  });
});

describe('the last update, as the Health page reports it', () => {
  const started = new Date('2026-10-19T09:00:00Z');
  const status = (state: UpdateStatus['state']): UpdateStatus => ({
    state,
    startedAt: started.toISOString(),
    finishedAt: null,
    from: 'abc1234',
    to: null,
    message: 'Updating.',
  });

  it('is nothing when there has never been an update', () => {
    expect(readUpdateStatus(join(dir, 'update-status.json'))).toBeNull();
  });

  it('reads back what the updater wrote', () => {
    const path = join(dir, 'update-status.json');
    writeFileSync(path, JSON.stringify({ ...status('done'), message: 'Updated.' }));
    expect(readUpdateStatus(path, started)).toMatchObject({ state: 'done', message: 'Updated.' });
  });

  it('stops calling an update "running" once it has been silent too long, so the button unlocks', () => {
    const path = join(dir, 'update-status.json');
    writeFileSync(path, JSON.stringify(status('running')));

    expect(readUpdateStatus(path, new Date(started.getTime() + 60_000))?.state).toBe('running');
    const later = new Date(started.getTime() + UPDATE_STALE_AFTER_MS + 1);
    expect(readUpdateStatus(path, later)).toMatchObject({ state: 'failed' });
  });

  it('ignores a damaged status file rather than breaking the Health page', () => {
    const path = join(dir, 'update-status.json');
    writeFileSync(path, '{ not json');
    expect(readUpdateStatus(path)).toBeNull();
  });
});

describe('where updating from the screen is allowed', () => {
  it('only on a production Windows install, never under next dev', () => {
    expect(updateUnsupportedReason('development', 'win32')).not.toBeNull();
    expect(updateUnsupportedReason('production', 'linux')).not.toBeNull();
    expect(updateUnsupportedReason('production', 'win32')).toBeNull();
  });
});
