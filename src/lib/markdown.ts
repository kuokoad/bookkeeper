/**
 * A very small Markdown parser, for the shop's own help pages.
 *
 * It parses to a DATA STRUCTURE rather than to HTML. That is the whole point:
 * the renderer builds React elements from these blocks, so nothing anywhere
 * needs `dangerouslySetInnerHTML`, and this file can be tested without a DOM.
 *
 * Deliberately not a Markdown library. It handles exactly the constructs the
 * files under `docs/` actually use, which is a set we write and control. A
 * general parser would bring a dependency tree several times the size of this
 * application's entire runtime, to render eight things. Anything it does not
 * recognise degrades to a paragraph of plain text rather than disappearing —
 * a help page that silently drops a sentence is worse than one that shows it
 * unstyled.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; content: Inline[] }
  | { kind: 'table'; headers: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' };

/**
 * Inline spans, left to right.
 *
 * Code is matched FIRST and its contents are never looked at again, so
 * `**` inside a code span stays literal — which matters when the thing being
 * documented is itself Markdown or SQL. Double-backtick spans come first and
 * match lazily: a backtick INSIDE the span is the only reason to reach for the
 * double form at all, so refusing one there would defeat the construct.
 */
const INLINE = /``(.+?)``|`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;

/** The words of a run of spans, with the formatting taken off. */
const flatten = (spans: Inline[]): string => spans.map((span) => span.text).join('');

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;

  for (const match of source.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push({ kind: 'text', text: source.slice(last, at) });

    const [, doubleCode, code, bold, linkText, href] = match;
    if (doubleCode !== undefined) out.push({ kind: 'code', text: doubleCode.trim() });
    else if (code !== undefined) out.push({ kind: 'code', text: code });
    else if (bold !== undefined) out.push({ kind: 'bold', text: bold });
    else if (linkText !== undefined && href !== undefined) {
      // A link's own label may be formatted — `[`README.md`](…)` is written
      // that way throughout the docs. A link carries one string rather than
      // nested spans, so the label is parsed and then flattened: the styling
      // inside it is dropped, the words are not. Leaving it unparsed would put
      // the backticks themselves on screen.
      out.push({ kind: 'link', text: flatten(parseInline(linkText)), href });
    }

    last = at + match[0].length;
  }

  if (last < source.length) out.push({ kind: 'text', text: source.slice(last) });
  return out;
}

/** A table row split on pipes, with the leading and trailing empties dropped. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const isDivider = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);

export function parseMarkdown(source: string): Block[] {
  // Windows checkouts hand us CRLF; every rule below is written for \n.
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];

  let paragraph: string[] = [];

  function flushParagraph(): void {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) });
    paragraph = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Fenced code. Everything inside is literal, including blank lines.
    if (line.startsWith('```')) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4,
        content: parseInline(heading[2]!),
      });
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'rule' });
      continue;
    }

    if (line.startsWith('> ')) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('> ')) {
        body.push((lines[i] ?? '').slice(2));
        i++;
      }
      i--;
      blocks.push({ kind: 'quote', content: parseInline(body.join(' ')) });
      continue;
    }

    // A table needs its divider row, or a line of prose containing a pipe
    // would be read as one.
    if (line.trim().startsWith('|') && isDivider(lines[i + 1] ?? '')) {
      flushParagraph();
      const headers = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(splitRow(lines[i] ?? '').map(parseInline));
        i++;
      }
      i--;
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const items: Inline[][] = [];

      while (i < lines.length) {
        const current = lines[i] ?? '';
        const match = ordered ? /^\d+\.\s+(.*)$/.exec(current) : /^[-*]\s+(.*)$/.exec(current);
        if (match) {
          items.push(parseInline(match[1]!));
          i++;
          continue;
        }
        // A wrapped continuation line belongs to the item above it.
        if (/^\s{2,}\S/.test(current) && items.length > 0) {
          const previous = items[items.length - 1]!;
          items[items.length - 1] = [...previous, ...parseInline(' ' + current.trim())];
          i++;
          continue;
        }
        break;
      }
      i--;

      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}
