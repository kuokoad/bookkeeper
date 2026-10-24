import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { env } from '@/lib/env';

/**
 * Updating the app from its own Health screen.
 *
 * The shop PC is a git clone of the application, so "is there an update?" is
 * "has the branch it tracks moved on?", and updating is what `deploy.ps1`
 * describes: pull, install, build, restart. The server cannot do that to
 * itself — `npm ci` replaces the database driver it holds open, and the build
 * replaces the files it serves — so `scripts/update.ps1` does it as a separate
 * process, and reports back through a status file beside the database.
 *
 * Nothing here touches the books. The updater takes a verified backup before
 * it changes anything, and migrations run at startup as they always do.
 */

const run = promisify(execFile);

/** Beside the database: git-ignored, so neither the update nor a rollback touches it. */
export const UPDATE_DATA_DIR = dirname(resolve(process.cwd(), env.DATABASE_PATH));
export const UPDATE_STATUS_PATH = join(UPDATE_DATA_DIR, 'update-status.json');

/**
 * The environment every git call here runs in. A git that wants a password
 * fails at once instead of waiting for a keyboard. And the folder is marked
 * safe: the shop PC is cloned from an Administrator PowerShell, so Windows
 * makes the Administrators group its owner, and git refuses a folder owned by
 * anyone but the user running it ("dubious ownership"), which the app is.
 * Environment config counts as command-line scope, which git trusts for this.
 */
export function gitEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: cwd.replace(/\\/g, '/'),
  };
}

export interface PendingChange {
  hash: string;
  subject: string;
}

export type UpdateCheck =
  | { ok: true; upstream: string; changes: PendingChange[] }
  | { ok: false; reason: string };

export interface InstalledVersion {
  hash: string;
  /** Commit date, YYYY-MM-DD. */
  date: string;
}

export interface UpdateStatus {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  from: string | null;
  to: string | null;
  message: string;
}

/**
 * An update that has said nothing for this long is not still running: the
 * updater died, or the PC was switched off mid-way. Without this the button
 * would stay locked for ever.
 */
export const UPDATE_STALE_AFTER_MS = 30 * 60_000;

/**
 * Why this copy cannot update itself, or null when it can. In development the
 * updater would stop `next dev` and rebuild over it, and it is a PowerShell
 * script, so it runs only on the Windows shop PC.
 */
export function updateUnsupportedReason(
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (nodeEnv !== 'production') return 'Updates run only on the shop computer, not in development.';
  if (platform !== 'win32') return 'Updating from this screen needs Windows. Use git pull and a rebuild instead.';
  return null;
}

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: gitEnv(cwd), timeout, windowsHide: true });
  return stdout.trim();
}

export async function getInstalledVersion(cwd: string): Promise<InstalledVersion | null> {
  try {
    const [hash = '', date = ''] = (await git(cwd, ['log', '-1', '--format=%h%x09%cs'])).split('\t');
    return hash ? { hash, date } : null;
  } catch {
    return null;
  }
}

/** Fetches the tracked branch and lists what it has that this copy does not. */
export async function checkForUpdates(cwd: string): Promise<UpdateCheck> {
  let upstream: string;
  try {
    upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    return {
      ok: false,
      reason:
        'This copy of the app is not linked to a place to download updates from. It needs to be installed with git clone, as DEPLOYMENT.md describes.',
    };
  }

  try {
    await git(cwd, ['fetch', '--quiet'], 60_000);
  } catch {
    return {
      ok: false,
      reason:
        'Could not reach the update server. Check this computer is online. If it asks for a password, sign in to git once from a terminal on this computer.',
    };
  }

  const log = await git(cwd, ['log', '--format=%h%x09%s', `HEAD..${upstream}`]);
  const changes = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', ...subject] = line.split('\t');
      return { hash, subject: subject.join('\t') };
    });
  return { ok: true, upstream, changes };
}

export function readUpdateStatus(path: string, now: Date = new Date()): UpdateStatus | null {
  if (!existsSync(path)) return null;
  let status: UpdateStatus;
  try {
    status = JSON.parse(readFileSync(path, 'utf8')) as UpdateStatus;
  } catch {
    return null;
  }
  if (!['running', 'done', 'failed'].includes(status.state)) return null;

  if (status.state === 'running' && now.getTime() - Date.parse(status.startedAt) > UPDATE_STALE_AFTER_MS) {
    return {
      ...status,
      state: 'failed',
      message:
        'The last update never reported back. Check the app is on the version you expect, and look in data/update.log.',
    };
  }
  return status;
}

/**
 * Hands over to `scripts/update.ps1` and returns at once. The script waits a
 * few seconds before stopping this server, so the caller's response gets out.
 */
export function startUpdate(options: { cwd: string; port: number; dataDir: string }): void {
  const statusPath = join(options.dataDir, 'update-status.json');
  const status: UpdateStatus = {
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    from: null,
    to: null,
    message: 'Updating.',
  };
  writeFileSync(statusPath, JSON.stringify(status, null, 2));

  const log = openSync(join(options.dataDir, 'update.log'), 'w');
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(options.cwd, 'scripts', 'update.ps1'),
        '-Port',
        String(options.port),
        '-StatusPath',
        statusPath,
      ],
      { cwd: options.cwd, env: gitEnv(options.cwd), detached: true, stdio: ['ignore', log, log], windowsHide: true },
    );
    child.unref();
  } finally {
    closeSync(log);
  }
}
