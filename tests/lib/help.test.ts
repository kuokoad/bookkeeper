import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findHelpPage, readHelpPage, HELP_PAGES } from '@/lib/help';
import type { Block, Inline } from '@/lib/markdown';
import { NAV_SECTIONS } from '@/components/shared/navigation';

/**
 * The help pages are the documentation files, read from disk at request time.
 * That is what keeps one copy of the words — and what makes a renamed file a
 * broken page rather than a compile error. These tests are the thing that
 * notices.
 */

const spans = (blocks: Block[]): Inline[] =>
  blocks.flatMap((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
      case 'quote':
        return block.content;
      case 'list':
        return block.items.flat();
      case 'table':
        return [...block.headers.flat(), ...block.rows.flat(2)];
      default:
        return [];
    }
  });

describe('the pages on offer', () => {
  it('offers something', () => {
    expect(HELP_PAGES.length).toBeGreaterThan(0);
  });

  it('every page points at a file that exists', () => {
    const missing = HELP_PAGES.filter((page) => !existsSync(join(process.cwd(), page.file)));
    expect(missing.map((page) => page.file)).toEqual([]);
  });

  it('reads the very file it names', () => {
    // The path is spelled twice — once as `file`, once inside `read` where the
    // build's tracer can see it. Nothing but this test stops the two drifting
    // apart and a page quietly serving the wrong document.
    for (const page of HELP_PAGES) {
      expect(page.read(), page.slug).toBe(
        readFileSync(join(process.cwd(), page.file), 'utf8'),
      );
    }
  });

  it('every slug is distinct, so no address is ambiguous', () => {
    expect(new Set(HELP_PAGES.map((page) => page.slug)).size).toBe(HELP_PAGES.length);
  });

  it('finds a page by its slug and refuses anything else', () => {
    expect(findHelpPage(HELP_PAGES[0]!.slug)?.file).toBe(HELP_PAGES[0]!.file);
    expect(findHelpPage('nope')).toBeUndefined();
    // The slug picks an entry; it never becomes part of a path.
    expect(findHelpPage('../../.env')).toBeUndefined();
  });
});

describe('reading a page', () => {
  it('produces blocks for every page', () => {
    for (const page of HELP_PAGES) {
      expect(readHelpPage(page).length, page.slug).toBeGreaterThan(3);
    }
  });

  it('drops the document title, which the page renders itself', () => {
    for (const page of HELP_PAGES) {
      const h1s = readHelpPage(page).filter(
        (block) => block.kind === 'heading' && block.level === 1,
      );
      expect(h1s, page.slug).toEqual([]);
    }
  });

  it('leaves no raw markdown in the words a reader sees', () => {
    // If `**bold**` reaches the screen with its asterisks, the parser missed a
    // construct the documentation actually uses.
    for (const page of HELP_PAGES) {
      // A SINGLE asterisk counts. The parser had no italics for a while, and
      // `*accounts*` reached the screen wearing them — this check looked only
      // for the doubled kind, so nothing said so.
      const leaked = spans(readHelpPage(page))
        .filter((span) => span.kind === 'text')
        .filter((span) => /\*|`|\]\(/.test(span.text));
      expect(leaked.map((span) => span.text), page.slug).toEqual([]);
    }
  });
});

describe('links go somewhere a reader can get to', () => {
  const allLinks = HELP_PAGES.flatMap((page) =>
    spans(readHelpPage(page))
      .filter((span) => span.kind === 'link')
      .map((span) => ({ page: page.slug, href: span.href })),
  );

  it('no link still points at a documentation file', () => {
    // `../reference/filters.md` means nothing in the app. Those become plain
    // text, keeping the words and losing only the dead address.
    const dead = allLinks.filter((link) => link.href.endsWith('.md'));
    expect(dead).toEqual([]);
  });

  it('every in-app link is an address this app serves', () => {
    const internal = allLinks.filter((link) => link.href.startsWith('/'));
    const bad = internal.filter((link) => !/^\/[a-z0-9/-]*$/.test(link.href));
    expect(bad).toEqual([]);
  });

  it('a link to the other help page becomes a help address', () => {
    // Not every set of served pages links between them, so this only asserts
    // the rewrite when such a link is present.
    const helpLinks = allLinks.filter((link) => link.href.startsWith('/help/'));
    for (const link of helpLinks) {
      expect(findHelpPage(link.href.slice('/help/'.length)), link.href).toBeDefined();
    }
  });
});

describe('the menu and the pages agree', () => {
  const helpItems = NAV_SECTIONS.flatMap((section) => section.items).filter((item) =>
    item.href.startsWith('/help'),
  );

  it('lists every page, and nothing else', () => {
    // The menu cannot import HELP_PAGES — that module reads the filesystem, and
    // the sidebar is a client component. So the two lists are written out
    // separately and this is what stops them drifting.
    expect(helpItems.map((item) => item.href).sort()).toEqual(
      HELP_PAGES.map((page) => `/help/${page.slug}`).sort(),
    );
  });

  it('labels each one the way its page titles itself', () => {
    for (const item of helpItems) {
      const page = findHelpPage(item.href.slice('/help/'.length));
      expect(item.label, item.href).toBe(page?.title);
    }
  });

  it('asks for no permission, so nobody is shown a shop they cannot be told how to use', () => {
    expect(helpItems.map((item) => item.module)).toEqual(helpItems.map(() => undefined));
  });
});
