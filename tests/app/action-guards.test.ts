import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every server action must authenticate before it does anything.
 *
 * A server action is a public HTTP endpoint. The browser cannot be trusted to
 * have hidden the button, so each one re-checks the session and the permission
 * on the server. That rule is enforced across 49 functions in 10 files, which
 * is exactly the kind of thing that holds until someone adds the fiftieth.
 *
 * These read the source rather than call it: the point is to cover every
 * exported action at once, including ones no test has been written for.
 */

const ACTIONS_DIR = join(process.cwd(), 'src', 'actions');

const actionFiles = readdirSync(ACTIONS_DIR)
  .filter((name) => name.endsWith('.actions.ts'))
  .map((name) => join(ACTIONS_DIR, name));

/** The body of each exported `…Action` function, up to the next export. */
function exportedActions(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const pattern = /export async function (\w*Action)\b/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index;
    const next = source.indexOf('\nexport ', start + 1);
    found.push({
      name: match[1] as string,
      body: source.slice(start, next === -1 ? source.length : next),
    });
  }
  return found;
}

/** Every function in the file by name, exported or not, so calls can be followed. */
function allFunctions(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const pattern = /(?:export )?(?:async )?function (\w+)\b/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index;
    const next = source.indexOf('\nfunction ', start + 1);
    const nextExport = source.indexOf('\nexport ', start + 1);
    const end = [next, nextExport].filter((index) => index !== -1).sort((a, b) => a - b)[0];
    bodies.set(match[1] as string, source.slice(start, end ?? source.length));
  }
  return bodies;
}

/**
 * Whether an action checks authorisation, directly or through a helper.
 *
 * Several actions are thin wrappers that delegate to a shared handler holding
 * the check — `recordOwnerCapitalAction` is one. Reading only the action's own
 * body would report those as unguarded when they are not, so calls to local
 * functions are followed.
 */
function guards(body: string, functions: Map<string, string>, seen = new Set<string>()): boolean {
  if (/\brequirePermission\(|\brequireUser\(/.test(body)) return true;

  for (const [name, fnBody] of functions) {
    if (seen.has(name)) continue;
    // Called somewhere in this body?
    if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
    seen.add(name);
    if (guards(fnBody, functions, seen)) return true;
  }
  return false;
}

/** Type-only imports are erased at compile time and ship nothing. */
function stripTypeImports(source: string): string {
  return source.replace(/^import type .*$/gm, '');
}

/**
 * Actions that legitimately run for someone not yet signed in. Each is listed
 * by name so adding a new one is a deliberate act, not an oversight.
 */
const PUBLIC_BY_DESIGN = new Set([
  // Signing in cannot require being signed in.
  'loginAction',
  'pinLoginAction',
  // First-run setup, which refuses once an owner exists.
  'setupOwnerAction',
  // Signing out checks the session itself and must work even from a stale one.
  'logoutAction',
]);

describe('server action authorisation', () => {
  it('finds the actions to check', () => {
    const total = actionFiles.reduce(
      (count, file) => count + exportedActions(readFileSync(file, 'utf8')).length,
      0,
    );
    // A guard that silently checks nothing is worse than no guard.
    expect(total).toBeGreaterThan(40);
  });

  it('every action either checks permission or is listed as public', () => {
    const offenders: string[] = [];

    for (const file of actionFiles) {
      const source = readFileSync(file, 'utf8');
      const functions = allFunctions(source);
      for (const action of exportedActions(source)) {
        if (PUBLIC_BY_DESIGN.has(action.name)) continue;
        if (!guards(action.body, functions)) {
          offenders.push(`${relative(process.cwd(), file)} → ${action.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no action takes the acting user from its own arguments', () => {
    // The actor must come from the session cookie. An action that accepted a
    // userId or role parameter would let the browser nominate who it is.
    const offenders: string[] = [];

    for (const file of actionFiles) {
      const source = readFileSync(file, 'utf8');
      for (const action of exportedActions(source)) {
        const signature = action.body.slice(0, action.body.indexOf(')') + 1);
        if (/\b(actorId|currentUserId|actingAs|asUser|role)\s*:/.test(signature)) {
          offenders.push(`${relative(process.cwd(), file)} → ${action.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('public actions are exactly the ones expected, and are rate limited', () => {
    // The sign-in paths are the only unauthenticated way in, so they carry the
    // throttle. If this list grows, that is a security decision to review.
    const authSource = readFileSync(join(ACTIONS_DIR, 'auth.actions.ts'), 'utf8');
    const publicFound = actionFiles.flatMap((file) =>
      exportedActions(readFileSync(file, 'utf8'))
        .map((action) => action.name)
        .filter((name) => PUBLIC_BY_DESIGN.has(name)),
    );

    expect(publicFound.sort()).toEqual([
      'loginAction',
      'logoutAction',
      'pinLoginAction',
      'setupOwnerAction',
    ]);

    // Both ways in must be throttled, and must share one key so a PIN cannot be
    // used to buy extra guesses at an account.
    const throttleKeys = [...authSource.matchAll(/const throttleKey = (`[^`]+`)/g)].map(
      (match) => match[1],
    );
    expect(throttleKeys.length).toBe(2);
    expect(new Set(throttleKeys).size).toBe(1);
  });
});

describe('secrets never leave the server', () => {
  it('no client component imports the database, or anything that reads it', () => {
    const clientFiles: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(full, 'utf8');
          if (/^['"]use client['"]/m.test(source)) clientFiles.push(full);
        }
      }
    };
    walk(join(process.cwd(), 'src'));

    expect(clientFiles.length).toBeGreaterThan(0);

    const offenders = clientFiles.filter((file) => {
      // Type-only imports are erased by the compiler, so they ship nothing.
      // What matters is a *value* import pulling server code into the bundle.
      const source = stripTypeImports(readFileSync(file, 'utf8'));
      return (
        /from ['"]@\/db\//.test(source) ||
        /from ['"]@\/services\//.test(source) ||
        /from ['"]@\/lib\/env['"]/.test(source)
      );
    });

    // A client component importing these would ship server code — and the
    // environment, secret included — into the browser bundle.
    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });
});
