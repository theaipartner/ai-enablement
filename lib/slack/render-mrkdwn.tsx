// Slack-mrkdwn → React renderer.
//
// Supports the subset of Slack's mrkdwn flavor relevant to Ella runs:
//
//   *text*               → <strong>
//   _text_               → <em>
//   ~text~               → <del>
//   `code`               → <code> (inline)
//   ```code```           → <pre><code> (block)
//   <@U...>              → @resolved name (via render-mentions)
//   <#C...|name>         → #name
//   <https://...|label>  → <a href="...">label</a>
//   <https://...>        → <a href="..."> bare URL </a>
//   • <text>             → bullet (renders the • literal; line break after)
//   single \n            → soft break (<br/>)
//   double \n+           → paragraph break
//
// Out of scope: tables, numbered lists, custom emoji (`:name:`), HTML
// escaping. React handles XSS-safe text rendering for the inputs we
// pass to <Fragment>; we trust the source.
//
// No external deps (per spec § Decision 6). The implementation is a
// two-pass tokenizer: first pass splits by paragraph (\n\n+), second
// pass walks each line, handling block syntax (code fences, bullets)
// and inline syntax (bold/italic/strike/code/mentions/links).
//
// Edge cases: unmatched delimiters render as raw characters (e.g.
// "Here's *bold" without a closing * renders as the literal `*bold`).
// That's intentional — Slack mrkdwn does the same.

import { Fragment, type ReactNode } from 'react'
import { renderMentions } from './render-mentions'

export type MrkdwnProps = {
  text: string
  mentionNameMap?: Map<string, string>
}

export function Mrkdwn({ text, mentionNameMap }: MrkdwnProps) {
  if (!text) return null
  // Mentions are rendered to "@First Last" text in a pre-pass so the
  // tokenizer doesn't have to special-case them inline. The mention
  // helper preserves the `<@...>` form on miss, which the tokenizer
  // then leaves as literal text.
  const resolved = mentionNameMap
    ? renderMentions(text, mentionNameMap)
    : text
  return <>{renderParagraphs(resolved)}</>
}

function renderParagraphs(text: string): ReactNode[] {
  // Split on 2+ newlines = paragraph break.
  const paragraphs = text.split(/\n{2,}/)
  const nodes: ReactNode[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]
    if (para.trim() === '') continue
    nodes.push(
      <p key={`p-${i}`} className="whitespace-pre-wrap break-words">
        {renderLines(para, i)}
      </p>,
    )
  }
  return nodes
}

function renderLines(paragraph: string, paraIdx: number): ReactNode[] {
  // Detect a triple-backtick code fence as the entire paragraph.
  const fence = paragraph.match(/^```\n?([\s\S]*?)\n?```$/)
  if (fence) {
    return [
      <pre
        key={`code-${paraIdx}`}
        className="rounded bg-zinc-100 p-2 font-mono text-xs"
      >
        {fence[1]}
      </pre>,
    ]
  }
  const lines = paragraph.split('\n')
  const nodes: ReactNode[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i > 0) nodes.push(<br key={`br-${paraIdx}-${i}`} />)
    if (line.startsWith('• ')) {
      nodes.push(
        <Fragment key={`bul-${paraIdx}-${i}`}>
          <span className="mr-1">•</span>
          {renderInline(line.slice(2), `${paraIdx}-${i}`)}
        </Fragment>,
      )
    } else {
      nodes.push(
        <Fragment key={`ln-${paraIdx}-${i}`}>
          {renderInline(line, `${paraIdx}-${i}`)}
        </Fragment>,
      )
    }
  }
  return nodes
}

// Inline tokenizer. Walks the string once; each delimiter scans forward
// for its closing match. Unmatched delimiters fall through as literal
// characters.
function renderInline(line: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let buf = ''
  let i = 0
  let nodeIdx = 0
  function flush(): void {
    if (buf.length > 0) {
      out.push(<Fragment key={`t-${key}-${nodeIdx++}`}>{buf}</Fragment>)
      buf = ''
    }
  }
  while (i < line.length) {
    const ch = line[i]
    // Slack link syntax: <https://...|label> or <https://...> or
    // <#CHANNELID|name> (mentions are already resolved before this
    // pass; any remaining <@U...> falls through as literal).
    if (ch === '<') {
      const close = line.indexOf('>', i + 1)
      if (close !== -1) {
        const inner = line.slice(i + 1, close)
        if (inner.startsWith('http://') || inner.startsWith('https://')) {
          flush()
          const pipe = inner.indexOf('|')
          const href = pipe === -1 ? inner : inner.slice(0, pipe)
          const label = pipe === -1 ? inner : inner.slice(pipe + 1)
          out.push(
            <a
              key={`a-${key}-${nodeIdx++}`}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-700 underline"
            >
              {label}
            </a>,
          )
          i = close + 1
          continue
        }
        if (inner.startsWith('#')) {
          flush()
          // `#CHANNELID|name` → `#name`. If there's no pipe, use the raw.
          const pipe = inner.indexOf('|')
          const name = pipe === -1 ? inner.slice(1) : inner.slice(pipe + 1)
          out.push(
            <Fragment key={`ch-${key}-${nodeIdx++}`}>#{name}</Fragment>,
          )
          i = close + 1
          continue
        }
      }
      // Not a recognized < ... > token; treat as literal.
      buf += ch
      i++
      continue
    }
    // Inline code: `code`
    if (ch === '`') {
      const close = line.indexOf('`', i + 1)
      if (close !== -1) {
        flush()
        out.push(
          <code
            key={`code-${key}-${nodeIdx++}`}
            className="rounded bg-zinc-100 px-1 font-mono text-xs"
          >
            {line.slice(i + 1, close)}
          </code>,
        )
        i = close + 1
        continue
      }
    }
    // Bold *text*. Slack mrkdwn: single asterisks, no spaces immediately
    // after the opening or before the closing. We approximate with a
    // boundary-tolerant scan.
    if (ch === '*') {
      const close = findClosing(line, '*', i + 1)
      if (close !== -1) {
        flush()
        out.push(
          <strong key={`b-${key}-${nodeIdx++}`}>
            {line.slice(i + 1, close)}
          </strong>,
        )
        i = close + 1
        continue
      }
    }
    // Italic _text_
    if (ch === '_') {
      const close = findClosing(line, '_', i + 1)
      if (close !== -1) {
        flush()
        out.push(
          <em key={`i-${key}-${nodeIdx++}`}>
            {line.slice(i + 1, close)}
          </em>,
        )
        i = close + 1
        continue
      }
    }
    // Strike ~text~
    if (ch === '~') {
      const close = findClosing(line, '~', i + 1)
      if (close !== -1) {
        flush()
        out.push(
          <del key={`s-${key}-${nodeIdx++}`}>
            {line.slice(i + 1, close)}
          </del>,
        )
        i = close + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

// Find the next occurrence of `delim` after `from`. Returns -1 if none.
// Could be tightened to require word-boundary behavior, but Slack itself
// is permissive — keep it simple and accept that some edge cases
// render as the literal delimiter.
function findClosing(line: string, delim: string, from: number): number {
  const idx = line.indexOf(delim, from)
  // Reject empty-content matches (e.g. ** in a row).
  if (idx === from) return -1
  return idx
}
