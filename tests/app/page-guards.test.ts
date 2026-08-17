import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural checks on how pages guard themselves.
 *
 * Authorisation is enforced in 48 separate files, so the risk is not that one
 * of them is wrong today — it is that the next page added copies the wrong
 * pattern. These read the source rather than run it, which is the only way to
 * make a rule that holds across every file at once.
 */

const APP_DIR = join(process.cwd(), 'src', 'app');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

const allFiles = walk(APP_DIR);
const pageFiles = allFiles.filter((file) => file.endsWith(`${sep}page.tsx`));
const routeFiles = allFiles.filter((file) => file.endsWith(`${sep}route.ts`));

const read = (file: string) => readFileSync(file, 'utf8');
const name = (file: string) => relative(process.cwd(), file);

describe('page authorisation', () => {
  it('finds the pages to check', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(pageFiles.length).toBeGreaterThan(40);
  });

  it('no page uses the throwing guard, which renders a server error', () => {
    // `requirePermission` throws; from a page that becomes a 500 page, telling
    // the person nothing. Pages must use `requirePageAccess`, which sends them
    // to an explanation instead.
    const offenders = pageFiles.filter((file) => /\brequirePermission\b/.test(read(file)));
    expect(offenders.map(name)).toEqual([]);
  });

  it('every page inside the app shell states an access decision', () => {
    // Pages outside `(app)` are the signed-out ones (login, setup) and the
    // account shell, which guard themselves in their own layout.
    const guarded = pageFiles.filter((file) => file.includes(`${sep}(app)${sep}`));
    const unguarded = guarded.filter((file) => {
      const source = read(file);
      return (
        !source.includes('requirePageAccess') &&
        // The dashboard and the no-access page itself are readable by anyone
        // signed in; they take the session without a permission check.
        !source.includes('getCurrentUser') &&
        !source.includes('requireUser')
      );
    });
    expect(unguarded.map(name)).toEqual([]);
  });

  it('API routes keep the throwing guard, so they answer with a status not a redirect', () => {
    const apiRoutes = routeFiles.filter((file) => file.includes(`${sep}api${sep}`));
    expect(apiRoutes.length).toBeGreaterThan(0);
    for (const file of apiRoutes) {
      const source = read(file);
      expect(source, name(file)).not.toMatch(/\brequirePageAccess\b/);
    }
  });
});

describe('streaming must not weaken a refusal', () => {
  it('any segment with a loading.tsx checks access in its layout', () => {
    // A `loading.tsx` wraps the page in Suspense, so the response headers are
    // flushed before the page runs. A `redirect()` or `notFound()` from inside
    // the page can then only happen in the browser — the HTTP status is already
    // 200, and anything that is not a browser sees the shell instead of a
    // refusal. Checking access in the layout, which renders before that
    // boundary, keeps the refusal a real HTTP redirect.
    const loadingFiles = allFiles.filter((file) => file.endsWith(`${sep}loading.tsx`));

    const offenders = loadingFiles.filter((file) => {
      const segment = file.slice(0, -`${sep}loading.tsx`.length);
      const layout = join(segment, 'layout.tsx');
      if (!allFiles.includes(layout)) return true;
      return !/requirePageAccess|requireUser|getCurrentUser/.test(read(layout));
    });

    expect(offenders.map(name)).toEqual([]);
  });
});

describe('pages that read the database render fresh', () => {
  it('every page under the app shell opts out of static prerendering', () => {
    // A prerendered page would bake one moment's balances into the build and
    // serve them for ever.
    const stale = pageFiles
      .filter((file) => file.includes(`${sep}(app)${sep}`))
      .filter((file) => !read(file).includes("export const dynamic = 'force-dynamic'"));
    expect(stale.map(name)).toEqual([]);
  });
});
