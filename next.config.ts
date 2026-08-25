import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — it must stay external to the server bundle.
  serverExternalPackages: ['better-sqlite3'],

  // NOT `output: 'standalone'`, deliberately.
  //
  // Standalone is for deployments that ship a prebuilt folder without running
  // `npm install`. This app is installed and built on the machine that runs it —
  // the shop's own PC — so it buys nothing here, and it costs
  // something: this project reads the migrations folder and the database path
  // through `process.cwd()`, which file tracing cannot follow, so it copies the
  // project root wholesale. Locally that put `.env` and `data/bookkeeper.db`
  // inside `.next/standalone` — the session secret and the whole set of
  // accounts, sitting in a folder someone might reasonably zip and upload.
  // `outputFileTracingExcludes` does not prevent it; it applies to per-route
  // traces, not to that root copy.
  //
  // A git-based deploy never contains either file (both are git-ignored), so
  // running `next start` is both simpler and the safer default. If standalone
  // is ever needed, delete `.env`, `data/` and `backups/` from the output
  // before shipping it anywhere.

  // Security headers. This app is local-first, but a shop WiFi is not a trusted
  // network, so we still lock the browser down.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },

  typescript: {
    // Never ship a build that does not typecheck. This is a financial system.
    ignoreBuildErrors: false,
  },
  // Next 16 removed the built-in `eslint` build hook and the `next lint`
  // command; linting runs as its own step via `npm run lint`.
};

export default nextConfig;
