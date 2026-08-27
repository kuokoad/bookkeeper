import Link from 'next/link';
import type { ReactNode } from 'react';

import type { Block, Inline } from '@/lib/markdown';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

/**
 * Renders parsed Markdown as React elements.
 *
 * Elements, not an HTML string — so there is no `dangerouslySetInnerHTML`
 * anywhere in this path. Even though the source is the shop's own documentation
 * rather than anything a user typed, an injection point that exists is an
 * injection point somebody will eventually feed something else.
 *
 * Styling matches the rest of the application: the same table primitives, the
 * same content colours. A help page should look like part of the app rather
 * than like a document that wandered into it.
 */

function InlineSpans({ content }: { content: Inline[] }): ReactNode {
  return content.map((span, index) => {
    switch (span.kind) {
      case 'bold':
        return (
          <strong key={index} className="font-semibold text-content">
            {span.text}
          </strong>
        );
      case 'code':
        return (
          <code
            key={index}
            className="rounded bg-surface-sunken px-1 py-0.5 text-[0.9em] text-content"
          >
            {span.text}
          </code>
        );
      case 'link':
        return span.href.startsWith('/') ? (
          <Link key={index} href={span.href} className="text-accent hover:underline">
            {span.text}
          </Link>
        ) : (
          <a
            key={index}
            href={span.href}
            className="text-accent hover:underline"
            rel="noreferrer noopener"
            target="_blank"
          >
            {span.text}
          </a>
        );
      default:
        return <span key={index}>{span.text}</span>;
    }
  });
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-8 mb-3 text-2xl font-semibold text-content',
  2: 'mt-8 mb-3 text-lg font-semibold text-content',
  3: 'mt-6 mb-2 text-base font-semibold text-content',
  4: 'mt-4 mb-2 text-sm font-semibold text-content',
};

export function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <div className="max-w-3xl">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[block.level - 1] ?? 'h2';
            return (
              <Tag key={index} className={HEADING_CLASS[block.level]}>
                <InlineSpans content={block.content} />
              </Tag>
            );
          }

          case 'paragraph':
            return (
              <p key={index} className="mb-3 text-sm leading-relaxed text-content-muted">
                <InlineSpans content={block.content} />
              </p>
            );

          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag
                key={index}
                className={
                  'mb-4 space-y-1.5 pl-5 text-sm leading-relaxed text-content-muted ' +
                  (block.ordered ? 'list-decimal' : 'list-disc')
                }
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineSpans content={item} />
                  </li>
                ))}
              </Tag>
            );
          }

          case 'code':
            return (
              <pre
                key={index}
                className="mb-4 overflow-x-auto rounded-xl border border-line bg-surface-sunken p-3 text-xs text-content"
              >
                <code>{block.text}</code>
              </pre>
            );

          case 'quote':
            return (
              <blockquote
                key={index}
                className="mb-4 border-l-2 border-line-strong pl-4 text-sm italic text-content-muted"
              >
                <InlineSpans content={block.content} />
              </blockquote>
            );

          case 'table':
            return (
              <TableWrap key={index} className="mb-4">
                <THead>
                  {block.headers.map((cell, cellIndex) => (
                    <TH key={cellIndex}>
                      <InlineSpans content={cell} />
                    </TH>
                  ))}
                </THead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <TR key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <TD key={cellIndex}>
                          <InlineSpans content={cell} />
                        </TD>
                      ))}
                    </TR>
                  ))}
                </tbody>
              </TableWrap>
            );

          case 'rule':
            return <hr key={index} className="my-6 border-line" />;

          default:
            return null;
        }
      })}
    </div>
  );
}
