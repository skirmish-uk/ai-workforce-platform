import { Fragment, type ReactNode } from 'react'

/** **bold** spans within a line, as React nodes (never HTML). */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>
  )
}

/**
 * An agent's answer, which models write in light markdown: paragraphs, "- " bullet lists and
 * **bold**. Anything else shows as written. Built from React nodes, so nothing in the text can
 * inject markup.
 */
export function AgentText({ text, className }: { text: string; className?: string }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc pl-5 space-y-1">
              {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>)}
            </ul>
          )
        }
        const heading = /^#{1,4}\s+/.test(block)
        return (
          <p key={i} className={heading ? 'font-semibold' : undefined}>
            {lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(heading ? l.replace(/^#{1,4}\s+/, '') : l)}</Fragment>)}
          </p>
        )
      })}
    </div>
  )
}
