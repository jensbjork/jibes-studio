import type { ReactNode } from 'react'
import { findAudioTokens, findImageTokens, findMalformedTokens, type PromptToken } from '@shared/prompt-refs'
import { KIND_TONE } from '../pickers/assetKinds'
import { useTokenCard, type TokenTarget } from '../pickers/ReferenceCard'
import { markKey } from '../prompt/promptText'

export type { TokenTarget }

interface Props {
  prompt: string
  /** One entry per reference image (an unsent one says why); empty outside reference mode. */
  targets: TokenTarget[]
  /** One entry per reference audio clip that is sent; empty when the model takes no audio. */
  audioTargets?: TokenTarget[]
  /** The picture or clip ("image:2", "audio:1") whose tokens are lit: hovered here, in another text or among the tiles. */
  highlighted?: string
  onHighlight?: (key: string | undefined) => void
  className?: string
}

interface Mark {
  start: number
  end: number
  node: ReactNode
}

const tokenBase = 'rounded px-0.5 font-medium outline-none focus-visible:ring-1 focus-visible:ring-white/70'
const broken = `${tokenBase} text-accent underline decoration-accent decoration-wavy underline-offset-2`

/**
 * A prompt, read-only, with its @ImageN and @AudioN tokens coloured like the reference chips: valid ones by the
 * kind of the asset they point at, tokens that point at nothing (or are misspelled) red and underlined. Hovering or
 * focusing a token shows its card – the picture, or the clip with a play button – and lights the tokens and tiles
 * that name the same picture or clip.
 */
export default function PromptText({
  prompt,
  targets,
  audioTargets = [],
  highlighted,
  onHighlight,
  className = ''
}: Props) {
  const card = useTokenCard()
  const marks: Mark[] = []
  const mark = (t: PromptToken, ref: 'image' | 'audio', list: TokenTarget[], nothing: string): void => {
    const target = list[t.index - 1]
    const key = markKey(ref, t.index)
    const tone = target?.kind ? KIND_TONE[target.kind].text : 'text-text'
    const lit = highlighted !== undefined && key === highlighted ? ' ring-1 ring-white/50' : ''
    const token = `${ref === 'image' ? '@Image' : '@Audio'}${t.index}`
    marks.push({
      start: t.start,
      end: t.end,
      node: (
        <span
          key={t.start}
          {...card.bind(
            t.start,
            { token, ref, target, ...(target ? {} : { problem: `${t.raw} ${nothing}` }) },
            { highlight: key, onHighlight }
          )}
          className={`${target && !target.unsent ? `${tokenBase} bg-white/5 ${tone}` : broken}${lit}`}
        >
          {t.raw}
        </span>
      )
    })
  }
  for (const t of findImageTokens(prompt)) mark(t, 'image', targets, 'pekar inte på någon av bilderna som skickas')
  for (const t of findAudioTokens(prompt)) mark(t, 'audio', audioTargets, 'pekar inte på något av ljudklippen som skickas')
  for (const m of findMalformedTokens(prompt)) {
    if (marks.some((x) => m.start < x.end && x.start < m.end)) continue
    marks.push({
      start: m.start,
      end: m.end,
      node: (
        <span
          key={m.start}
          {...card.bind(m.start, {
            token: m.raw,
            ref: 'image',
            problem: m.suggestion ? `Felskriven referens – menar du ${m.suggestion}?` : 'Felskriven referens'
          })}
          className={broken}
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

  return (
    <>
      <p className={`whitespace-pre-wrap break-words leading-relaxed select-text ${className}`}>{parts}</p>
      {card.card}
    </>
  )
}
