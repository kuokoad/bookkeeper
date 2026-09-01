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

describe('a menu link never demands more than the page behind it', () => {
  /**
   * The Dashboard link used to require `reports`, while the dashboard page
   * itself requires only a session — and every sign-in redirects there. So a
   * staff account was sent to a page its own menu then refused to mention, and
   * the only route back was the "no access" screen's escape button.
   *
   * Hiding a link is a convenience; the page's guard is the protection. But a
   * link hidden from somebody allowed to open the page is just a page nobody
   * can find, so the two have to agree.
   */
  const navSource = read(join(process.cwd(), 'src', 'components', 'shared', 'navigation.ts'));

  const navItems = [...navSource.matchAll(/\{ href: '([^']+)'[^}]*?\}/g)].map((match) => ({
    href: match[1] as string,
    module: (/module: '([^']+)'/.exec(match[0]) ?? [])[1],
  }));

  it('finds the menu to check', () => {
    expect(navItems.length).toBeGreaterThan(10);
  });

  it('every link agrees with the guard on the page it points at', () => {
    const offenders: string[] = [];

    for (const item of navItems) {
      const page = join(APP_DIR, '(app)', ...item.href.split('/').filter(Boolean), 'page.tsx');
      let source: string;
      try {
        source = read(page);
      } catch {
        continue; // Not every link is a page in this tree; those are covered elsewhere.
      }

      const guard = (/requirePageAccess\(\s*'([^']+)'/.exec(source) ?? [])[1];

      if (item.module === undefined && guard !== undefined) {
        offenders.push(`${item.href}: menu asks for nothing, page requires "${guard}"`);
      }
      if (item.module !== undefined && guard !== item.module) {
        offenders.push(
          `${item.href}: menu asks for "${item.module}", page requires "${guard ?? 'nothing'}"`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the dashboard in particular asks for no permission', () => {
    // It is where every sign-in lands. A menu that can hide it would hide the
    // page the person is standing on.
    const dashboard = navItems.find((item) => item.href === '/dashboard');
    expect(dashboard).toBeDefined();
    expect(dashboard?.module).toBeUndefined();
  });
});

describe('the dashboard shows only what the person may see', () => {
  /**
   * The dashboard is not one module, so it cannot be gated by a single
   * `requirePageAccess` call — it is a wall of cards, each answering a question
   * from a different part of the books.
   *
   * It used to ask nobody's permission at all: a till assistant given `sales`
   * alone opened it and was shown the shop's cash position, its debts, its
   * margins and its ledger totals. Hiding cards in the markup would not have
   * been enough, because the figures would still have been queried and sent to
   * the browser, so the READS are gated too.
   */
  const source = readFileSync(
    join(process.cwd(), 'src', 'app', '(app)', 'dashboard', 'page.tsx'),
    'utf8',
  );

  it('decides what to show from the signed-in user', () => {
    expect(source).toContain("can(user, 'accounts', 'view')");
    expect(source).toContain("can(user, 'sales', 'view')");
    expect(source).toContain("can(user, 'expenses', 'view')");
    expect(source).toContain("can(user, 'customers', 'view')");
    expect(source).toContain("can(user, 'inventory', 'view')");
  });

  it('sends nobody to a dashboard without a session', () => {
    expect(source).toContain("redirect('/login')");
  });

  it('does not query figures it is not going to show', () => {
    // Each of these reads money the person may not be entitled to see, so each
    // must sit behind its gate rather than run unconditionally.
    for (const call of [
      'getPaymentAccountBalances(db)',
      // Was `getTrialBalance(db)`. The Books check card now uses the same
      // measure as the Accounting hub and the Trial balance page, which were
      // showing a different figure under the same "Total debits" label. The
      // gate is what this test is about, and it is unchanged.
      'checkBooksIntegrity(db)',
      'getTotalReceivables(db)',
      'getTotalPayables(db)',
    ]) {
      const index = source.indexOf(call);
      expect(index, `${call} is not in the page`).toBeGreaterThan(-1);

      // The assignment must be conditional: `shows.x ? call : …`.
      const line = source.slice(source.lastIndexOf('\n', index) + 1, index);
      expect(line, `${call} runs unconditionally`).toMatch(/shows\.\w+\s*\?/);
    }
  });
});
