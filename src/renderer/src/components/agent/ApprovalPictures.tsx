import { useState, type CSSProperties, type ReactNode } from 'react'
import type { Asset, AssetKind } from '@shared/types'
import { fileName } from '../../lib/library'
import { mediaUrl } from '../../lib/media'
import { KIND_TONE, VIDEO_TONE } from '../pickers/assetKinds'
import VideoWindowPreview from '../pickers/VideoWindowPreview'
import { useTokenCard } from '../pickers/ReferenceCard'

// The pictures of an approval request: small tiles that light up with the prompt's tokens naming them, and show the
// picture larger while hovered (or focused from the keyboard); reference videos play the part that is sent. Nothing
// opens on a click: a request can be looked at from the dialog, not changed.

/** A library photo: its asset and its place among the asset's photos. */
export interface Photo {
  asset: Asset
  /** 1-based among the asset's photos. */
  number: number
}

/** What a picture's hover card says besides its badge: the asset's photo, or a name of its own. */
export interface PictureInfo {
  photo?: Photo
  /** What it is when it isn't a library photo: "Board 2", "Last frame of clip 3". */
  name?: string
  /** Its kind when it isn't a library photo (the colour of its name). */
  kind?: AssetKind
}

/**
 * A request's picture (`children`) with its hover card: the picture larger after a short delay on hover, at once on
 * keyboard focus, with `badge` and what it is. `onLight` tells while it is hovered or focused.
 */
export function PictureHover({
  path,
  badge,
  info,
  onLight,
  className,
  style,
  children
}: {
  path: string
  badge: string
  info: PictureInfo
  onLight?: (on: boolean) => void
  className: string
  style?: CSSProperties
  children: ReactNode
}) {
  const card = useTokenCard()
  const { photo, name, kind } = info
  const hover = card.hover(
    0,
    {
      token: badge,
      ref: 'image',
      target: {
        kind: photo?.asset.kind ?? kind,
        label: photo ? `${photo.asset.name} (photo ${photo.number})` : (name ?? fileName(path)),
        path,
        name: photo?.asset.name ?? name,
        number: photo?.number,
        count: photo?.asset.images.length
      }
    },
    onLight && { highlight: badge, onHighlight: (key) => onLight(key !== undefined) }
  )
  const what = photo ? `${photo.asset.name}, photo ${photo.number}` : (name ?? fileName(path))
  return (
    <>
      <div tabIndex={0} aria-label={`${badge}: ${what}`} {...hover} className={className} style={style}>
        {children}
      </div>
      {card.card}
    </>
  )
}

/**
 * One picture of a request: a reference photo, a start or end image, a frame. Hovering it shows it larger; `lit`
 * rings it while a token naming it is hovered, and `onLight` tells while it is hovered itself.
 */
export function ImageTile({
  path,
  badge,
  photo,
  caption,
  captionTone,
  large,
  title,
  kind,
  lit,
  onLight
}: {
  path: string
  badge: string
  photo?: Photo
  /** Shown along the bottom instead of the photo's asset name. */
  caption?: string
  captionTone?: string
  /** A bigger, wide tile (frames and stills rather than reference photos). */
  large?: boolean
  /** The hover card's name when it says more than the caption. */
  title?: string
  /** The kind of a picture that isn't a library photo (the colour of its name on the card). */
  kind?: AssetKind
  lit?: boolean
  onLight?: (on: boolean) => void
}) {
  const [missing, setMissing] = useState(false)
  return (
    <PictureHover
      path={path}
      badge={badge}
      info={{ photo, name: title ?? caption, kind }}
      onLight={onLight}
      className={`relative block shrink-0 overflow-hidden rounded bg-raised text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-white/70 ${
        large ? 'h-24 w-40' : 'h-16 w-16'
      } ${lit ? 'ring-2 ring-white/70' : missing ? 'ring-1 ring-accent' : ''}`}
    >
      {missing ? (
        <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
          File missing
        </span>
      ) : (
        <img
          src={mediaUrl(path)}
          alt=""
          draggable={false}
          onError={() => setMissing(true)}
          className="h-full w-full object-cover"
        />
      )}
      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">{badge}</span>
      {caption ? (
        <span
          className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${captionTone ?? 'bg-black/60'}`}
        >
          {caption}
        </span>
      ) : (
        photo && (
          <span
            className={`absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${KIND_TONE[photo.asset.kind].caption}`}
          >
            {photo.asset.name}
          </span>
        )
      )}
    </PictureHover>
  )
}

/**
 * One reference video of a request: its first frame, the part that would be sent playing while hovered (or focused),
 * its @VideoN badge and the window. `lit` rings it while a token naming it is hovered; `onLight` tells while it is
 * hovered itself. `unsent`: past the model family's count, so it isn't sent (dimmed, with why).
 */
export function VideoTile({
  path,
  badge,
  start,
  length,
  caption,
  windowText,
  unsent,
  lit,
  onLight
}: {
  path: string
  badge: string
  start: number
  length: number
  /** What the video is ("Clip 3 in “Summer”"), along the bottom. */
  caption: string
  /** "0:00–0:05 (5 s)": the part that is sent. */
  windowText: string
  unsent?: string
  lit?: boolean
  onLight?: (on: boolean) => void
}) {
  const [playing, setPlaying] = useState(false)
  const on = (value: boolean) => () => {
    setPlaying(value)
    onLight?.(value)
  }
  return (
    <div
      tabIndex={0}
      aria-label={`${badge}: ${caption}, ${windowText}${unsent ? ` – ${unsent}` : ''}`}
      title={unsent ?? `${caption} · ${windowText} – the part that is sent plays while you point at it`}
      onMouseEnter={on(true)}
      onMouseLeave={on(false)}
      onFocus={on(true)}
      onBlur={on(false)}
      className={`relative block h-[72px] w-32 shrink-0 overflow-hidden rounded bg-black text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-white/70 ${
        lit ? 'ring-2 ring-white/70' : ''
      } ${unsent ? 'opacity-45' : ''}`}
    >
      <VideoWindowPreview path={path} start={start} length={length} playing={playing} />
      <span className={`absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] ${VIDEO_TONE.text}`}>{badge}</span>
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/85 to-transparent px-1 pb-0.5 pt-2 text-[10px] text-white">
        <span className="min-w-0 flex-1 truncate">{unsent ? 'Not sent' : caption}</span>
        <span className="shrink-0 tabular-nums">{windowText.replace(/^.*\((.*)\)$/, '$1')}</span>
      </span>
    </div>
  )
}
