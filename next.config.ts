import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — it must stay external to the server bundle.
  serverExternalPackages: ['better-sqlite3'],

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
