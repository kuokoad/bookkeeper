import 'server-only';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';

/**
 * The help pages, served from the shop's own machine.
 *
 * The app is built to work with no internet — that is the point of it running
 * on the counter computer — so help cannot be a link to a website. These read
 * the same Markdown files that live under `docs/`, which keeps one copy of the
 * words rather than a second set inside the app that drifts from the first.
 *
 * Only the pages written FOR A SHOP OWNER are served. The reference and
 * explanation pages are written for whoever maintains the code and would be a
 * dead end at the till.
 */

export interface HelpPage {
  slug: string;
  title: string;
  blurb: string;
  /** Relative to the repository root; also what relative links resolve against. */
  file: string;
  /**
   * Reads that same file.
   *
   * The path is written out again, literally, instead of `readFileSync(file)`.
   * The build traces filesystem reads to decide what to copy, and it can only
   * follow a literal — handed a variable it gives up and traces the whole
   * project, which is the warning next.config.ts explains. The two spellings of
   * the path are held together by a test.
   */
  read: () => string;
}

export const HELP_PAGES: readonly HelpPage[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    blurb:
      'Set the shop up, put something on the shelf, sell it, and see what it earned.',
    file: 'docs/tutorials/first-hour.md',
    read: () => readFileSync(join(process.cwd(), 'docs/tutorials/first-hour.md'), 'utf8'),
  },
  {
    slug: 'finding-things',
    title: 'Finding things',
    blurb:
      'Narrow any list to exactly what you want, and take it away as a spreadsheet.',
    file: 'docs/how-to/find-anything.md',
    read: () => readFileSync(join(process.cwd(), 'docs/how-to/find-anything.md'), 'utf8'),
  },
  {
    slug: 'quoting',
    title: 'Quoting a customer',
    blurb:
      'Give a contractor a price they can take away, then turn it into a sale without typing it again.',
    file: 'docs/how-to/quote-a-customer.md',
    read: () => readFileSync(join(process.cwd(), 'docs/how-to/quote-a-customer.md'), 'utf8'),
  },
  {
    slug: 'fixing-a-mistake',
    title: 'Fixing a mistake',
    blurb:
      'Undo a wrong sale, take goods back, or correct a count — without deleting anything.',
    file: 'docs/how-to/fix-a-mistake.md',
    read: () => readFileSync(join(process.cwd(), 'docs/how-to/fix-a-mistake.md'), 'utf8'),
  },
  {
    slug: 'managing-tax',
    title: 'Managing tax',
    blurb:
      "Set up Ghana's three taxes, and change a rate when the budget moves one.",
    file: 'docs/how-to/manage-tax.md',
    read: () => readFileSync(join(process.cwd(), 'docs/how-to/manage-tax.md'), 'utf8'),
  },
  {
    slug: 'closing-a-period',
    title: 'Closing a period',
    blurb:
      'Lock a month once it is filed, close a year, and produce the pack your accountant asks for.',
    file: 'docs/how-to/close-a-period.md',
    read: () => readFileSync(join(process.cwd(), 'docs/how-to/close-a-period.md'), 'utf8'),
  },
  {
    slug: 'backups',
    title: 'Backups',
    blurb:
      'The routine that keeps the books safe, and what to do on a bad day.',
    file: 'docs/how-to/back-up-and-restore.md',
    read: () => readFileSync(join(process.cwd(), 'docs/how-to/back-up-and-restore.md'), 'utf8'),
  },
];

export function findHelpPage(slug: string): HelpPage | undefined {
  return HELP_PAGES.find((page) => page.slug === slug);
}

/** Which document each served page came from, for rewriting links between them. */
const SERVED_BY_FILE = new Map(
  HELP_PAGES.map((page) => [page.file.split('/').pop() ?? '', `/help/${page.slug}`]),
);

/**
 * Point a link somewhere a reader can actually get to.
 *
 * These files live in a documentation tree and link to each other with relative
 * paths. In the app those paths mean nothing: `../reference/filters.md` is not a
 * page here, and following it would take somebody standing at a till to a 404.
 *
 * So a link to another SERVED page becomes an app link, and a link to anything
 * else loses its href and stays as plain text. Dropping the words as well would
 * leave a sentence with a hole in it.
 */
function resolveLink(href: string): string | null {
  if (/^https?:\/\//.test(href)) return href;
  if (href.startsWith('/')) return href;

  const target = href.split('#')[0]?.split('/').pop() ?? '';
  return SERVED_BY_FILE.get(target) ?? null;
}

function rewriteInline(content: Inline[]): Inline[] {
  return content.map((span) => {
    if (span.kind !== 'link') return span;
    const href = resolveLink(span.href);
    return href === null ? { kind: 'text', text: span.text } : { ...span, href };
  });
}

function rewriteBlock(block: Block): Block {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return { ...block, content: rewriteInline(block.content) };
    case 'list':
      return { ...block, items: block.items.map(rewriteInline) };
    case 'table':
      return {
        ...block,
        headers: block.headers.map(rewriteInline),
        rows: block.rows.map((row) => row.map(rewriteInline)),
      };
    default:
      return block;
  }
}

/**
 * One help page, parsed and ready to render.
 *
 * The document's own H1 is dropped: the page renders its title from
 * `HELP_PAGES` in the app's own heading style, and two titles stacked on one
 * screen reads like a mistake.
 */
export function readHelpPage(page: HelpPage): Block[] {
  const source = page.read();
  const blocks = parseMarkdown(source).map(rewriteBlock);

  const firstHeading = blocks.findIndex(
    (block) => block.kind === 'heading' && block.level === 1,
  );
  return firstHeading === -1
    ? blocks
    : [...blocks.slice(0, firstHeading), ...blocks.slice(firstHeading + 1)];
}
