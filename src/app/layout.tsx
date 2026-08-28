import type { Metadata, Viewport } from 'next';
import './globals.css';
import { themeAttribute } from '@/lib/theme';
import { getTheme } from '@/lib/theme.server';
import { lookAttribute } from '@/lib/look';
import { getLook } from '@/lib/look.server';

export const metadata: Metadata = {
  title: {
    default: 'NunaBooks',
    template: '%s · NunaBooks',
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Both read on the server and written onto <html> before the page is sent, so
  // the right palette is there from the first paint rather than swapped in
  // after. They are independent: brightness comes from a cookie on this device,
  // the look from the shop's own settings, and every combination is painted.
  const theme = await getTheme();
  const look = getLook();

  return (
    <html lang="en" {...themeAttribute(theme)} {...lookAttribute(look)}>
      <body className="min-h-dvh bg-surface text-content antialiased">{children}</body>
    </html>
  );
}
