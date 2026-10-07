import type { ReactNode } from 'react'
import { findAudioTokens, findImageTokens, findMalformedTokens } from '@shared/prompt-refs'
import type { AssetKind } from '@shared/types'
import { KIND_TONE, OWN_IMAGE_TOKEN as OWN_TOKEN } from '../pickers/assetKinds'
import type { AudioReference, ImageReference } from './references'

interface Props {
  text: string
  /** The reference images that were sent, in @ImageN order. */
  images: readonly ImageReference[]
  /** The reference audio clips that were sent, in @AudioN order. */
  audios: readonly AudioReference[]
  /** The token whose picture or clip is hovered elsewhere, e.g. "@Image2". */
  highlighted?: string
  onHover?: (token: string | undefined) => void
  className?: string
}

interface Mark {
  start: number
  end: number
  node: ReactNode
}

const base = 'rounded px-0.5 font-medium transition-colors'
const broken = `${base} text-accent underline decoration-accent decoration-wavy underline-offset-2`

/**
 * A finished generation's prompt, read-only, with its @ImageN and @AudioN tokens coloured like the asset they
 * point at, so it is easy to see which picture or voice each part of the text was about. Tokens that pointed at
 * nothing, and misspelled ones, are red.
 */
export default function HighlightedPrompt({ text, images, audios, highlighted, onHover, className = '' }: Props) {
  const references = images.filter((r) => r.role === 'reference')
  const marks: Mark[] = []

  const tokenNode = (key: number, raw: string, canonical: string, kind: AssetKind | undefined, label: string) => (
    <span
      key={key}
      title={`${canonical} · ${label}`}
      onMouseEnter={() => onHover?.(canonical)}
      onMouseLeave={() => onHover?.(undefined)}
      className={`${base} ${kind ? KIND_TONE[kind].token : OWN_TOKEN} ${highlighted === canonical ? 'ring-1 ring-white/50' : ''}`}
    >
      {raw}
    </span>
  )

  for (const t of findImageTokens(text)) {
    const ref = references[t.index - 1]
    const canonical = `@Image${t.index}`
    marks.push({
      start: t.start,
      end: t.end,
      node:
        ref && !ref.unsent ? (
          tokenNode(t.start, t.raw, canonical, ref.asset?.kind, ref.asset ? `${ref.asset.name} (foto ${ref.photo ?? 1})` : 'egen bild')
        ) : (
          <span key={t.start} title={`${t.raw} pekade inte på någon bild som skickades`} className={broken}>
            {t.raw}
          </span>
        )
    })
  }
  for (const t of findAudioTokens(text)) {
    if (marks.some((m) => t.start < m.end && m.start < t.end)) continue
    const ref = audios[t.index - 1]
    const canonical = `@Audio${t.index}`
    marks.push({
      start: t.start,
      end: t.end,
      node: ref ? (
        tokenNode(t.start, t.raw, canonical, ref.asset?.kind, ref.asset ? `${ref.asset.name} (ljud)` : 'eget ljud')
      ) : (
        <span key={t.start} title={`${t.raw} pekade inte på något ljud som skickades`} className={broken}>
          {t.raw}
        </span>
      )
    })
  }
  for (const m of findMalformedTokens(text)) {
    if (marks.some((x) => m.start < x.end && x.start < m.end)) continue
    marks.push({
      start: m.start,
      end: m.end,
      node: (
        <span
          key={m.start}
          title={m.suggestion ? `Felskriven referens – menade ${m.suggestion}` : 'Felskriven referens'}
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
    if (m.start > at) parts.push(text.slice(at, m.start))
    parts.push(m.node)
    at = m.end
  }
  if (at < text.length) parts.push(text.slice(at))

  return <p className={`whitespace-pre-wrap break-words leading-relaxed select-text ${className}`}>{parts}</p>
}
