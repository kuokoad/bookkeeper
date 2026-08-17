import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Whether this module is the file Node was asked to run.
 *
 * These modules are both command-line tools and ordinary imports —
 * `preflight.ts` is imported by the health page, `backup.ts` by the download
 * route. Their command-line block must therefore never execute on import: it
 * prints to stdout and, worse, calls `process.exit()`. Getting that wrong
 * inside the web server would take the shop offline.
 *
 * Earlier versions guessed from the filename ("does the entry point start with
 * 'backup'?"), which is a prefix match on something the caller controls. This
 * compares the resolved entry path with this module's own path, which is exact
 * — and verified to hold under `tsx`, which is how these are run.
 */
export function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;

  try {
    return resolve(entry) === resolve(fileURLToPath(moduleUrl));
  } catch {
    // A non-file URL cannot be an entry point.
    return false;
  }
}
