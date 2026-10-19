import type { ReactNode } from 'react'
import { findAudioTokens, findImageTokens, findMalformedTokens, findVideoTokens } from '@shared/prompt-refs'
import { KIND_TONE, OWN_IMAGE_TOKEN as OWN_TOKEN, VIDEO_TONE } from '../pickers/assetKinds'
import { audioRole } from '../pickers/audioRefs'
import { useTokenCard, type TokenCardContent, type TokenTarget } from '../pickers/ReferenceCard'
import { videoLabelParts } from '../pickers/videoRefs'
import type { AudioReference, ImageReference, VideoReference } from './references'

interface Props {
  text: string
  /** The reference images that were sent, in @ImageN order. */
  images: readonly ImageReference[]
  /** The reference audio clips that were sent, in @AudioN order. */
  audios: readonly AudioReference[]
  /** The reference videos that were sent, in @VideoN order. */
  videos?: readonly VideoReference[]
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
    label: ref.asset ? `${ref.asset.name} (photo ${ref.photo ?? 1})` : 'own image',
    path: ref.path,
    name: ref.asset?.name,
    number: ref.photo,
    count: ref.asset?.images.length,
    ...(ref.unsent ? { unsent: 'Not sent – the model took no more images' } : {})
  }
}

/** A sound clip that was sent, for the token's hover card. */
function audioTarget(ref: AudioReference): TokenTarget {
  return {
    kind: ref.asset?.kind,
    label: ref.asset ? `${ref.asset.name} · ${audioRole(ref.asset.kind)}` : 'own sound',
    path: ref.path,
    name: ref.asset?.name,
    number: ref.number,
    count: ref.asset?.audio?.length,
    window: { start: ref.start, length: ref.length }
  }
}

/** A reference video that was sent, for the token's hover card. */
export function videoTarget(ref: VideoReference): TokenTarget {
  const { name, detail } = videoLabelParts(ref)
  return {
    label: `${name} · ${detail}`,
    path: ref.path,
    name,
    detail,
    window: { start: ref.start, length: ref.length },
    ...(ref.unsent ? { unsent: 'Not sent – the model took no more videos' } : {})
  }
}

/**
 * A finished generation's prompt, read-only, with its @ImageN, @AudioN and @VideoN tokens coloured like what they
 * point at, so it is easy to see which picture, voice or video each part of the text was about. Tokens that pointed
 * at nothing, and misspelled ones, are red. Hovering or focusing a token shows its card: the picture, the clip with
 * a play button for the part that was sent, or the video playing that part.
 */
export default function HighlightedPrompt({
  text,
  images,
  audios,
  videos = [],
  highlighted,
  onHover,
  className = ''
}: Props) {
  const references = images.filter((r) => r.role === 'reference')
  const card = useTokenCard()
  const marks: Mark[] = []

  const tokenNode = (key: number, raw: string, canonical: string, content: TokenCardContent, valid: boolean) => {
    const kind = content.target?.kind
    const tone = content.ref === 'video' ? VIDEO_TONE.token : kind ? KIND_TONE[kind].token : OWN_TOKEN
    return (
      <span
        key={key}
        {...card.bind(key, content, { highlight: canonical, onHighlight: onHover })}
        className={valid ? `${base} ${tone} ${highlighted === canonical ? 'ring-1 ring-white/50' : ''}` : broken}
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
          : { token: canonical, ref: 'image', problem: `${t.raw} didn’t point at any image that was sent` },
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
          : { token: canonical, ref: 'audio', problem: `${t.raw} didn’t point at any sound that was sent` },
        !!ref
      )
    })
  }
  for (const t of findVideoTokens(text)) {
    if (marks.some((m) => t.start < m.end && m.start < t.end)) continue
    const ref = videos[t.index - 1]
    const canonical = `@Video${t.index}`
    marks.push({
      start: t.start,
      end: t.end,
      node: tokenNode(
        t.start,
        t.raw,
        canonical,
        ref
          ? { token: canonical, ref: 'video', target: videoTarget(ref) }
          : { token: canonical, ref: 'video', problem: `${t.raw} didn’t point at any video that was sent` },
        !!ref && !ref.unsent
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
            problem: m.suggestion ? `Misspelled reference – meant ${m.suggestion}` : 'Misspelled reference'
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
