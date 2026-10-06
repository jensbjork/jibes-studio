import type { ReactNode } from 'react'
import { findImageTokens, findMalformedTokens } from '@shared/prompt-refs'
import type { AssetKind } from '@shared/types'
import { KIND_TONE } from '../pickers/assetKinds'

/** What @ImageN (index N-1) shows, for colouring and the tooltip. */
export interface TokenTarget {
  kind?: AssetKind
  /** "Anna (foto 2)" */
  label: string
}

interface Props {
  prompt: string
  /** One entry per reference image that is sent; empty outside reference mode. */
  targets: TokenTarget[]
  className?: string
}

interface Mark {
  start: number
  end: number
  node: ReactNode
}

const tokenBase = 'rounded px-0.5 font-medium'

/**
 * A prompt, read-only, with its @ImageN tokens coloured like the reference chips: valid ones by the kind of
 * the picture they point at, tokens that point at nothing (or are misspelled) red and underlined.
 */
export default function PromptText({ prompt, targets, className = '' }: Props) {
  const marks: Mark[] = []
  for (const t of findImageTokens(prompt)) {
    const target = targets[t.index - 1]
    const tone = target?.kind ? KIND_TONE[target.kind].text : 'text-text'
    marks.push({
      start: t.start,
      end: t.end,
      node: target ? (
        <span key={t.start} title={`${t.raw} · ${target.label}`} className={`${tokenBase} bg-white/5 ${tone}`}>
          {t.raw}
        </span>
      ) : (
        <span
          key={t.start}
          title={`${t.raw} pekar inte på någon av bilderna som skickas`}
          className={`${tokenBase} text-accent underline decoration-accent decoration-wavy underline-offset-2`}
        >
          {t.raw}
        </span>
      )
    })
  }
  for (const m of findMalformedTokens(prompt)) {
    if (marks.some((x) => m.start < x.end && x.start < m.end)) continue
    marks.push({
      start: m.start,
      end: m.end,
      node: (
        <span
          key={m.start}
          title={m.suggestion ? `Felskriven referens – menar du ${m.suggestion}?` : 'Felskriven referens'}
          className={`${tokenBase} text-accent underline decoration-accent decoration-wavy underline-offset-2`}
        >
          {m.raw}
        </span>
      )
    })
  }
  marks.sort((a, b) => a.start - b.start)

  const parts: ReactNode[] = []
  let at = 0
  for (const m of marks) {
    if (m.start < at) continue
    if (m.start > at) parts.push(prompt.slice(at, m.start))
    parts.push(m.node)
    at = m.end
  }
  if (at < prompt.length) parts.push(prompt.slice(at))

  return <p className={`whitespace-pre-wrap break-words leading-relaxed select-text ${className}`}>{parts}</p>
}
