import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/current-user';
import { findHelpPage, readHelpPage } from '@/lib/help';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';
import { Markdown } from '@/components/shared/markdown';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = findHelpPage(slug);
  return { title: page ? `${page.title} — Help` : 'Help' };
}

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { slug } = await params;
  const page = findHelpPage(slug);
  // Only the pages named in HELP_PAGES are readable. The slug decides which
  // entry is used, never which file is opened, so no address can reach a file
  // that was not meant to be served.
  if (!page) notFound();

  let blocks;
  try {
    blocks = readHelpPage(page);
  } catch {
    // The help text ships with the software and should always be there. If it
    // is not, say so plainly rather than showing an error page — nothing about
    // the shop's records is wrong, only the instructions are missing.
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={page.title} />
        <p className="rounded-xl border border-dashed border-line-strong bg-surface-raised px-6 py-10 text-center text-sm text-content-muted">
          This help page could not be read from the machine. Your records are not
          affected. Whoever installed the software can restore it from the{' '}
          <code>docs</code> folder.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={page.title}
        // No description: every one of these documents opens with a sentence
        // saying what it is for, and the blurb is that sentence. Printing both
        // put the same line on screen twice.
        actions={
          <Link href="/help">
            <Button variant="secondary" size="sm">
              All help
            </Button>
          </Link>
        }
      />

      <Markdown blocks={blocks} />

      {/*
        One line, not a button for every other guide. The menu already lists
        them all, and a strip that grows by one every time a page is written
        ends up longer than the thing a reader came for.
      */}
      <div className="mt-10 border-t border-line pt-4">
        <Link href="/help" className="text-sm font-medium text-accent hover:underline">
          All the guides
        </Link>
      </div>
    </div>
  );
}
