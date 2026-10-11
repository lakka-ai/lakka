import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '../../i18n/index.ts';
import { CodeBlock } from '../patterns/code-block.tsx';
import { Icon } from '../icons.tsx';

/*
 * A reply's Markdown (CH-1, ADR 0105). The reply comes from a model and may carry anything a
 * prompt or a tool result put into it, so it is untrusted:
 *
 * - React elements are built from the parsed text; no HTML string reaches the page, and raw HTML
 *   in the reply is dropped.
 * - Links work only for http, https and mailto, open in a new tab, and tell the other site
 *   nothing about where they came from.
 * - An image is never loaded: it is a link to its address, named by its alt text. Loading it
 *   would send whatever the address carries to whoever chose it.
 * - Headings start at level 2, under the conversation's title, the page's h1.
 * - A table scrolls sideways in a focusable region of its own, so the page never does. The
 *   regions are numbered, so two in a reply do not share a name.
 *
 * GFM adds tables, strikethrough, task lists and bare links. A single newline stays a line
 * break, as replies were shown before.
 */

const SAFE_URL = /^(https?:|mailto:)/i;

/** The parts of a Markdown tree this file touches. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

function withBreaks(node: MdNode): void {
  if (node.children === undefined) return;
  node.children = node.children.flatMap((child): MdNode[] =>
    child.type === 'text' && child.value?.includes('\n') === true
      ? child.value
          .split('\n')
          .flatMap((line, i): MdNode[] =>
            i === 0
              ? [{ type: 'text', value: line }]
              : [{ type: 'break' }, { type: 'text', value: line }],
          )
      : [child],
  );
  node.children.forEach(withBreaks);
}

/**
 * A single newline inside a paragraph is a line break, as replies were shown before, where
 * Markdown would join the lines. Code is a node of its own, so its newlines are untouched.
 */
function softBreaks() {
  return withBreaks;
}

/** The parts of an HTML tree this file touches. */
interface HtmlNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

/**
 * Numbers a reply's tables in order, so each scroll region has a name of its own: "Table 2,
 * scrolls sideways".
 */
function numberTables() {
  return (tree: HtmlNode) => {
    let n = 0;
    const walk = (node: HtmlNode): void => {
      if (node.type === 'element' && node.tagName === 'table') {
        n += 1;
        node.properties = { ...node.properties, dataNumber: n };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/** The address if it is one a reply may link to, else undefined. */
export function safeUrl(url: string | null | undefined): string | undefined {
  const trimmed = url?.trim() ?? '';
  return SAFE_URL.test(trimmed) ? trimmed : undefined;
}

function Link({ href, children }: { href: string | undefined; children: ReactNode }) {
  const url = safeUrl(href);
  if (url === undefined) return <span>{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="lk-link">
      {children}
    </a>
  );
}

const text = 'text-chat';

const components: Components = {
  p: ({ children }) => <p className={text}>{children}</p>,
  h1: ({ children }) => <h2 className="text-dialog-title">{children}</h2>,
  h2: ({ children }) => <h3 className="text-chat font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="text-chat font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="text-chat font-semibold">{children}</h5>,
  h5: ({ children }) => <h6 className="text-chat font-semibold">{children}</h6>,
  h6: ({ children }) => <h6 className="text-chat font-semibold">{children}</h6>,
  ul: ({ children, className }) => (
    <ul
      className={`flex flex-col gap-1 pl-6 ${className === 'contains-task-list' ? 'list-none pl-1' : 'list-disc'}`}
    >
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="flex list-decimal flex-col gap-1 pl-6">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className={text}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="flex flex-col gap-3 border-l-2 border-border pl-3 text-muted">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src, alt }) => (
    <Link href={typeof src === 'string' ? src : undefined}>
      {alt !== undefined && alt !== '' ? alt : t('chat.markdown.image')}
    </Link>
  ),
  // The block's own code element drops its inline look: the block draws the fill.
  pre: ({ children }) => (
    <CodeBlock className="[&_code]:bg-transparent [&_code]:p-0 [&_code]:text-small">
      {children}
    </CodeBlock>
  ),
  code: ({ children, className }) => (
    <code className={`rounded bg-lk-code px-1 py-0.5 font-mono text-[0.9em] ${className ?? ''}`}>
      {children}
    </code>
  ),
  table: ({ children, node }) => (
    <div
      role="region"
      aria-label={t('chat.markdown.table', { n: String(node?.properties['dataNumber'] ?? 1) })}
      tabIndex={0}
      className="lk-focus overflow-x-auto rounded-note border border-border"
    >
      <table className="w-full border-collapse text-body">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-border bg-surface-secondary px-3 py-2 text-left text-caption font-medium text-muted"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-separator px-3 py-2.5 align-top">
      {children}
    </td>
  ),
  hr: () => <hr className="border-separator" />,
  // A task list item's box: not a form control, since a reply cannot be ticked, so it draws a
  // box and says Done or Not done to screen readers.
  input: ({ checked, type }) =>
    type === 'checkbox' ? (
      <>
        <span
          aria-hidden="true"
          className="mr-2 inline-flex size-4 -translate-y-px items-center justify-center rounded border border-field-border align-middle"
        >
          {checked === true && <Icon name="check" className="size-3" />}
        </span>
        <span className="sr-only">
          {checked === true ? t('chat.markdown.taskDone') : t('chat.markdown.taskOpen')}
        </span>
      </>
    ) : null,
};

export function Markdown({ text: source }: { text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, softBreaks]}
        rehypePlugins={[numberTables]}
        components={components}
        skipHtml
        // Links and images are checked again where they are drawn; this keeps anything else out.
        urlTransform={(url) => safeUrl(url) ?? ''}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
