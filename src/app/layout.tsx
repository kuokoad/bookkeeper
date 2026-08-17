import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Shop Bookkeeper',
    template: '%s · Shop Bookkeeper',
  },
  description: 'Bookkeeping, inventory, sales and accounts for a small retail shop.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Staff need to zoom into a receipt; never disable it.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-surface text-content antialiased">{children}</body>
    </html>
  );
}
