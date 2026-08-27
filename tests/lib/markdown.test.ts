import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown, type Block } from '@/lib/markdown';

/**
 * The help pages are rendered from these blocks, so a construct this parser
 * mishandles is a sentence a shop owner reads wrong — or does not read at all.
 * The rule the parser is held to: nothing may VANISH. Anything unrecognised has
 * to come out the other side as text.
 */

const text = (blocks: Block[]): string =>
  blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
        case 'quote':
          return block.content.map((span) => span.text).join('');
        case 'list':
          return block.items.map((item) => item.map((span) => span.text).join('')).join('\n');
        case 'code':
          return block.text;
        case 'table':
          return [block.headers, ...block.rows]
            .map((row) => row.map((cell) => cell.map((span) => span.text).join('')).join(' '))
            .join('\n');
        default:
          return '';
      }
    })
    .join('\n');

describe('inline spans', () => {
  it('reads plain text as one span', () => {
    expect(parseInline('just words')).toEqual([{ kind: 'text', text: 'just words' }]);
  });

  it('separates bold, code and links from the words around them', () => {
    expect(parseInline('Press **Save** then run `npm test` and see [docs](/help)')).toEqual([
      { kind: 'text', text: 'Press ' },
      { kind: 'bold', text: 'Save' },
      { kind: 'text', text: ' then run ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' and see ' },
      { kind: 'link', text: 'docs', href: '/help' },
    ]);
  });

  it('leaves markdown inside a code span alone', () => {
    // The documentation explains markdown and SQL, so `**` and `|` appear
    // inside code spans meaning themselves. Formatting them would be a lie
    // about what to type.
    expect(parseInline('write `**bold**` like this')).toEqual([
      { kind: 'text', text: 'write ' },
      { kind: 'code', text: '**bold**' },
      { kind: 'text', text: ' like this' },
    ]);
  });

  it('a double-backtick span may contain a backtick', () => {
    expect(parseInline('type `` `x` `` here')).toEqual([
      { kind: 'text', text: 'type ' },
      { kind: 'code', text: '`x`' },
      { kind: 'text', text: ' here' },
    ]);
  });

  it('keeps an unmatched asterisk as a character rather than eating it', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }]);
  });
});

describe('blocks', () => {
  it('reads headings at each level it supports', () => {
    const blocks = parseMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four');
    expect(blocks.map((block) => block.kind === 'heading' && block.level)).toEqual([1, 2, 3, 4]);
  });

  it('joins the lines of a wrapped paragraph', () => {
    const blocks = parseMarkdown('A sentence that\nwraps in the file.');
    expect(blocks).toHaveLength(1);
    expect(text(blocks)).toBe('A sentence that wraps in the file.');
  });

  it('separates paragraphs on a blank line', () => {
    expect(parseMarkdown('First.\n\nSecond.')).toHaveLength(2);
  });

  it('reads bullet and numbered lists', () => {
    const blocks = parseMarkdown('- one\n- two\n\n1. first\n2. second');
    expect(blocks.map((block) => block.kind === 'list' && block.ordered)).toEqual([false, true]);
    expect(text(blocks)).toBe('one\ntwo\nfirst\nsecond');
  });

  it('attaches an indented continuation to the item above it', () => {
    const blocks = parseMarkdown('- a point that\n  carries on\n- another');
    expect(blocks).toHaveLength(1);
    expect(text(blocks)).toBe('a point that carries on\nanother');
  });

  it('keeps fenced code exactly as written, blank lines and all', () => {
    const blocks = parseMarkdown('```bash\nnpm run dev\n\nnpm test\n```');
    expect(blocks).toEqual([{ kind: 'code', text: 'npm run dev\n\nnpm test' }]);
  });

  it('does not format markdown inside a fence', () => {
    const blocks = parseMarkdown('```\n- not a list\n**not bold**\n```');
    expect(blocks).toEqual([{ kind: 'code', text: '- not a list\n**not bold**' }]);
  });

  it('reads a table only when the divider row is there', () => {
    const table = parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(table).toHaveLength(1);
    expect(table[0]?.kind).toBe('table');
    expect(text(table)).toBe('A B\n1 2');
  });

  it('treats a sentence containing a pipe as a sentence', () => {
    const blocks = parseMarkdown('Use grep | head to shorten it.');
    expect(blocks[0]?.kind).toBe('paragraph');
    expect(text(blocks)).toBe('Use grep | head to shorten it.');
  });

  it('joins the lines of a blockquote', () => {
    const blocks = parseMarkdown('> careful here\n> and here');
    expect(blocks[0]?.kind).toBe('quote');
    expect(text(blocks)).toBe('careful here and here');
  });

  it('reads a horizontal rule', () => {
    expect(parseMarkdown('one\n\n---\n\ntwo').map((block) => block.kind)).toEqual([
      'paragraph',
      'rule',
      'paragraph',
    ]);
  });

  it('reads a file written with Windows line endings', () => {
    // The repository is checked out on Windows; every rule in the parser is
    // written for \n, so the \r has to go before any of them run.
    expect(text(parseMarkdown('# Title\r\n\r\n- one\r\n- two\r\n'))).toBe('Title\none\ntwo');
  });

  it('never loses a line it does not recognise', () => {
    const odd = '<div>raw html</div>';
    expect(text(parseMarkdown(odd))).toContain('raw html');
  });
});

describe('a link whose label is itself formatted', () => {
  it('shows the words without their markers', () => {
    // The docs write [`README.md`](…). A link carries one string, so the label
    // loses its styling — but never its words, and never gains backticks.
    expect(parseInline('see [`README.md`](/help) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'README.md', href: '/help' },
      { kind: 'text', text: ' now' },
    ]);
  });
});
