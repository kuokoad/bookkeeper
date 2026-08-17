'use client';

import { useEffect } from 'react';

/**
 * The last resort: a failure in the root layout itself, where the normal error
 * boundary and the app's own styling are both unavailable.
 *
 * It replaces the whole document, so it must render its own `<html>` and
 * `<body>`, and it cannot rely on the stylesheet having loaded. Everything here
 * is inline for that reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('The application failed to start:', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          background: '#f6f7f9',
          color: '#101828',
        }}
      >
        <main style={{ maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.5rem' }}>The application could not start</h1>
          <p style={{ margin: '0 0 0.75rem', lineHeight: 1.5 }}>
            Nothing was saved, and your records are untouched — they are stored in the database
            file, not in this page.
          </p>
          <p style={{ margin: '0 0 1rem', lineHeight: 1.5, color: '#475467' }}>
            If reloading does not help, stop the app and start it again. If it still fails, the
            server log will explain why.
          </p>
          {error.digest && (
            <p style={{ margin: '0 0 1rem', fontSize: '0.8125rem', color: '#475467' }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: '1px solid #101828',
              background: '#101828',
              color: '#fff',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
