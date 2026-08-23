import { z } from 'zod';

/**
 * Validated environment. Fails fast and loudly at startup rather than producing
 * a subtly broken system later — a shop must not discover a misconfiguration
 * halfway through a day's trading.
 */

// Next.js loads .env itself. Standalone tsx scripts (migrate/seed) do not, so
// load it here when it has not already happened.
//
// Variables already present in the environment WIN over the file: running
// `DATABASE_PATH=... npm run db:migrate` to point at a different database must
// work, and must not stop the rest of .env being read.
if (typeof process.loadEnvFile === 'function') {
  const fromShell = { ...process.env };
  try {
    process.loadEnvFile();
  } catch {
    // No .env file yet — defaults and the explicit errors below take over.
  }
  for (const [key, value] of Object.entries(fromShell)) {
    if (value !== undefined) process.env[key] = value;
  }
}

// preprocess (rather than .transform().default()) so an absent variable
// deterministically becomes `false` regardless of Zod's default-placement rules.
const booleanish = z.preprocess((v) => v === 'true' || v === '1', z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_PATH: z.string().min(1).default('./data/bookkeeper.db'),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters. Run `npm run env:init`.'),

  SEED_DEMO_DATA: booleanish,

  /**
   * Marks the session cookie `Secure`, so the browser will only send it over
   * HTTPS. Off by default because the shop runs over plain HTTP on its own LAN,
   * where `Secure` would stop the cookie being sent at all and nobody could
   * sign in. Turn it on the moment the app is put behind HTTPS.
   */
  COOKIE_SECURE: booleanish,

  /**
   * Whether `X-Forwarded-For` / `X-Real-IP` can be believed.
   *
   * Off by default, because the shop runs the app directly and anyone can put
   * whatever they like in those headers. Believed blindly, they defeat the
   * sign-in rate limit entirely: a different forged value on each request looks
   * like a different visitor each time, so the counter never reaches its limit.
   *
   * Turn it on ONLY when a reverse proxy in front of the app overwrites the
   * header — and note that a proxy which appends rather than overwrites still
   * leaves the left-most value under the caller's control.
   */
  TRUST_PROXY_HEADERS: booleanish,
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  // Tests and migrations run without a real secret; supply a clearly-fake one
  // that is never valid in production.
  const isTest = process.env['NODE_ENV'] === 'test' || process.env['VITEST'] === 'true';

  // `next build` evaluates this module in its page-data workers. A managed host
  // injects the application's environment into the *running server*, not into
  // the build that precedes it, so the real secret is simply not there yet —
  // and a build never signs a session, so it does not need one. Accept a
  // clearly-fake stand-in for the build alone. `next start` runs without this
  // phase set, so a live server still refuses to boot without a real secret.
  const isBuild = process.env['NEXT_PHASE'] === 'phase-production-build';

  // Held separately from the parsed value so the placeholder check below can
  // tell "the host gave us a bad secret" from "we supplied the stand-in".
  const suppliedSecret = process.env['SESSION_SECRET'];

  const parsed = schema.safeParse({
    NODE_ENV: process.env['NODE_ENV'],
    DATABASE_PATH: process.env['DATABASE_PATH'],
    SESSION_SECRET:
      suppliedSecret ?? (isTest || isBuild ? 'test-only-secret-'.padEnd(48, 'x') : undefined),
    SEED_DEMO_DATA: process.env['SEED_DEMO_DATA'],
    COOKIE_SECURE: process.env['COOKIE_SECURE'],
    TRUST_PROXY_HEADERS: process.env['TRUST_PROXY_HEADERS'],
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy env.example to .env and run `npm run env:init` to generate a secret.',
    );
  }

  const env = parsed.data;

  // Only meaningful for a secret that actually came from the environment. The
  // build's stand-in is ours, and never serves a request.
  if (env.NODE_ENV === 'production' && suppliedSecret !== undefined) {
    if (env.SESSION_SECRET.startsWith('replace-me') || env.SESSION_SECRET.includes('test-only')) {
      throw new Error('SESSION_SECRET is still the placeholder value. Run `npm run env:init`.');
    }
  }

  // NOTE: the "no demo data in production" rule is deliberately NOT enforced
  // here. `next build` runs with NODE_ENV=production and evaluates this module,
  // so a seed-time rule enforced at import time would break every build. It is
  // asserted in the seed runner instead — the only place that can actually
  // write demo rows. See `assertDemoSeedAllowed`.
  return env;
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Enforced at the moment demo data would actually be written, rather than at
 * import time, so it can never be bypassed and can never break a build.
 */
export function assertDemoSeedAllowed(): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed demo data with NODE_ENV=production. ' +
        'Demo records must never enter a real shop database.',
    );
  }
}
