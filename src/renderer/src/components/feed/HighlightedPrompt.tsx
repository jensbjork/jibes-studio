import type { ReactNode } from 'react'
import { findAudioTokens, findImageTokens, findMalformedTokens } from '@shared/prompt-refs'
import { KIND_TONE, OWN_IMAGE_TOKEN as OWN_TOKEN } from '../pickers/assetKinds'
import { audioRole } from '../pickers/audioRefs'
import { useTokenCard, type TokenCardContent, type TokenTarget } from '../pickers/ReferenceCard'
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

const base = 'rounded px-0.5 font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/70'
const broken = `${base} text-accent underline decoration-accent decoration-wavy underline-offset-2`

/** A picture that was sent, for the token's hover card. */
function imageTarget(ref: ImageReference): TokenTarget {
  return {
    kind: ref.asset?.kind,
    label: ref.asset ? `${ref.asset.name} (foto ${ref.photo ?? 1})` : 'egen bild',
    path: ref.path,
    name: ref.asset?.name,
    number: ref.photo,
    count: ref.asset?.images.length,
    ...(ref.unsent ? { unsent: 'Skickades inte – modellen tog inte fler bilder' } : {})
  }
}

/** A sound clip that was sent, for the token's hover card. */
function audioTarget(ref: AudioReference): TokenTarget {
  return {
    kind: ref.asset?.kind,
    label: ref.asset ? `${ref.asset.name} · ${audioRole(ref.asset.kind)}` : 'eget ljud',
    path: ref.path,
    name: ref.asset?.name,
    number: ref.number,
    count: ref.asset?.audio?.length,
    window: { start: ref.start, length: ref.length }
  }
}

/**
 * A finished generation's prompt, read-only, with its @ImageN and @AudioN tokens coloured like the asset they
 * point at, so it is easy to see which picture or voice each part of the text was about. Tokens that pointed at
 * nothing, and misspelled ones, are red. Hovering or focusing a token shows its card: the picture, or the clip
 * with a play button for the part that was sent.
 */
export default function HighlightedPrompt({ text, images, audios, highlighted, onHover, className = '' }: Props) {
  const references = images.filter((r) => r.role === 'reference')
  const card = useTokenCard()
  const marks: Mark[] = []

  const tokenNode = (key: number, raw: string, canonical: string, content: TokenCardContent, valid: boolean) => {
    const kind = content.target?.kind
    return (
      <span
        key={key}
        {...card.bind(key, content, { highlight: canonical, onHighlight: onHover })}
        className={
          valid
            ? `${base} ${kind ? KIND_TONE[kind].token : OWN_TOKEN} ${highlighted === canonical ? 'ring-1 ring-white/50' : ''}`
            : broken
        }
      >
        {raw}
      </span>
    )
  }

  for (const t of findImageTokens(text)) {
    const ref = references[t.index - 1]
    const canonical = `@Image${t.index}`
    marks.push({
      start: t.start,
      end: t.end,
      node: tokenNode(
        t.start,
        t.raw,
        canonical,
        ref
          ? { token: canonical, ref: 'image', target: imageTarget(ref) }
          : { token: canonical, ref: 'image', problem: `${t.raw} pekade inte på någon bild som skickades` },
        !!ref && !ref.unsent
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
      node: tokenNode(
        t.start,
        t.raw,
        canonical,
        ref
          ? { token: canonical, ref: 'audio', target: audioTarget(ref) }
          : { token: canonical, ref: 'audio', problem: `${t.raw} pekade inte på något ljud som skickades` },
        !!ref
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
          {...card.bind(m.start, {
            token: m.raw,
            ref: 'image',
            problem: m.suggestion ? `Felskriven referens – menade ${m.suggestion}` : 'Felskriven referens'
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
    if (m.start > at) parts.push(text.slice(at, m.start))
    parts.push(m.node)
    at = m.end
  }
  if (at < text.length) parts.push(text.slice(at))

  return (
    <>
      <p className={`whitespace-pre-wrap break-words leading-relaxed select-text ${className}`}>{parts}</p>
      {card.card}
    </>
  )
}
