import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import type { AssetKind } from '@shared/types'
import { ASSET_COPY } from '../../lib/assets'
import { mediaUrl } from '../../lib/media'
import { placeBeside } from '../prompt/textareaDom'
import AudioPlayButton, { toggleClip } from './AudioPlayButton'
import { KIND_TONE } from './assetKinds'
import { audioRole, windowLabel } from './audioRefs'

// A card that shows what an @ImageN or @AudioN token in a read-only prompt points at – the picture large enough
// to recognise, or the clip with a play button for the part that is sent – so a prompt can be checked against its
// references without leaving it. The token spans stay plain text until a card opens: nothing is loaded before.
// The same card shows a reference thumbnail (or an approval tile) larger while it is hovered: the picture variant.

/** What @ImageN (or @AudioN; index N-1) points at, for colouring the token and for its card. */
export interface TokenTarget {
  kind?: AssetKind
  /** "Anna (photo 2)", "Anna · voice": what it is, in one line. */
  label: string
  /** The picture or clip file; without it the card names it only. */
  path?: string
  /** The asset's name; undefined for a file of its own. */
  name?: string
  /** Which of the asset's photos or clips it is (1-based), and how many the asset has. */
  number?: number
  count?: number
  /**
   * Why it isn't sent, e.g. "Not sent – the model takes at most 3 images": the token is then marked like one that names
   * nothing, and the card says so under the picture.
   */
  unsent?: string
  /** The part of a clip that is sent, in seconds (no length: from `start`, length unknown). */
  window?: { start: number; length?: number }
}

/** What a token's card is about. */
export interface TokenCardContent {
  /** The token as it is meant: "@Image2", "@Audio1" (or as written, for a misspelled one). */
  token: string
  ref: 'image' | 'audio'
  target?: TokenTarget
  /** Why the token names nothing that is sent (misspelled, out of range); the card then says only that, in red. */
  problem?: string
  /** A last line on what the picture does, e.g. "Click to swap – drag to move". */
  hint?: string
}

interface BindOptions {
  /** The key ("image:2", "audio:1") reported to `onHighlight` while the token is hovered or focused. */
  highlight?: string
  onHighlight?: (key: string | undefined) => void
}

/** What shows the card on an element that has its own focus, clicks and keys (a thumbnail, a tile). */
export type CardHover = Pick<
  HTMLAttributes<HTMLElement>,
  'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'aria-describedby'
>

interface Open {
  id: number
  content: TokenCardContent
  anchor: HTMLElement
  rect: DOMRect
}

/** The card waits this long, so it doesn't flash up while the pointer only passes over a token. */
const OPEN_DELAY_MS = 150
/** Time to move the pointer from the token into the card (to reach the play button) before it closes. */
const CLOSE_DELAY_MS = 150

/**
 * One card for a prompt's tokens or a row of pictures: `bind(id, content)` gives a token's span what it needs
 * (focusable; the card after a short delay on hover, at once on keyboard focus; Enter plays a clip), `hover(id,
 * content)` only the card's hover and focus handlers, for a picture that has its own focus, click and keys, `hide()`
 * closes it at once (a press or a drag on the picture), and `card` is the card itself. The card stays while the
 * pointer is on it (to reach a clip's play button; a picture's card lets the pointer through), closes on leave,
 * Escape (only the card – not a dialog underneath), scroll or resize, and is placed above or below its anchor, never
 * over it, inside the window.
 */
export function useTokenCard(): {
  bind: (id: number, content: TokenCardContent, options?: BindOptions) => HTMLAttributes<HTMLElement>
  hover: (id: number, content: TokenCardContent, options?: BindOptions) => CardHover
  hide: () => void
  card: ReactNode
} {
  const cardId = useId()
  const [open, setOpen] = useState<Open>()
  const openRef = useRef(open)
  openRef.current = open
  const cardRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number>(undefined)

  const clear = (): void => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }
  const show = (next: Omit<Open, 'rect'>, delay: number): void => {
    clear()
    const run = (): void => {
      if (next.anchor.isConnected) setOpen({ ...next, rect: next.anchor.getBoundingClientRect() })
    }
    if (delay > 0) timer.current = window.setTimeout(run, delay)
    else run()
  }
  const hide = (delay = CLOSE_DELAY_MS): void => {
    clear()
    if (delay > 0) timer.current = window.setTimeout(() => setOpen(undefined), delay)
    else setOpen(undefined)
  }
  useEffect(() => clear, [])

  const isOpen = !!open
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Captured and stopped: Escape closes the card, and the dialog or drawer under it stays.
      e.preventDefault()
      e.stopPropagation()
      hide(0)
    }
    // Its place was measured where the token was: the token moving (a box around it scrolled) or the window
    // changing takes it away. Not another list scrolling meanwhile (thumbnails loading in the feed, say).
    const onMove = (): void => hide(0)
    const onScroll = (e: Event): void => {
      const anchor = openRef.current?.anchor
      if (e.target === document || (e.target instanceof Node && anchor && e.target.contains(anchor))) hide(0)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('blur', onMove)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('blur', onMove)
    }
  }, [isOpen])

  // A card whose anchor left the page (a swapped picture is a new element) is not shown, nor counted as open.
  const shown = open && open.anchor.isConnected ? open : undefined

  const hover = (id: number, content: TokenCardContent, options: BindOptions = {}): CardHover => {
    const { highlight, onHighlight } = options
    const next = (anchor: HTMLElement): Omit<Open, 'rect'> => ({ id, content, anchor })
    return {
      'aria-describedby': shown?.id === id ? cardId : undefined,
      onMouseEnter: (e) => {
        onHighlight?.(highlight)
        // From one token (or picture) to the next the card follows at once.
        show(next(e.currentTarget), openRef.current?.anchor.isConnected ? 0 : OPEN_DELAY_MS)
      },
      onMouseLeave: () => {
        onHighlight?.(undefined)
        hide()
      },
      onFocus: (e) => {
        // Keyboard focus only: a click focuses a token or a thumbnail too, as does a picker handing the focus back.
        if (e.target !== e.currentTarget || !e.currentTarget.matches(':focus-visible')) return
        onHighlight?.(highlight)
        show(next(e.currentTarget), 0)
      },
      onBlur: (e) => {
        if (e.target !== e.currentTarget) return
        onHighlight?.(undefined)
        if (!(e.relatedTarget instanceof Node && cardRef.current?.contains(e.relatedTarget))) hide(0)
      }
    }
  }

  const bind = (id: number, content: TokenCardContent, options: BindOptions = {}): HTMLAttributes<HTMLElement> => {
    const clipWindow = content.ref === 'audio' ? content.target?.window : undefined
    const audioPath = content.target && !content.target.unsent ? content.target.path : undefined
    return {
      tabIndex: 0,
      ...hover(id, content, options),
      onKeyDown: (e) => {
        if ((e.key !== 'Enter' && e.key !== ' ') || !audioPath || !clipWindow?.length) return
        e.preventDefault()
        toggleClip(audioPath, clipWindow.start, clipWindow.length)
      }
    }
  }

  const card = shown ? (
    <ReferenceCard
      id={cardId}
      ref={cardRef}
      content={shown.content}
      rect={shown.rect}
      onMouseEnter={clear}
      onMouseLeave={() => hide()}
    />
  ) : null
  return { bind, hover, hide: () => hide(0), card }
}

const WIDTH = 256
/** The picture's long side. */
const PICTURE = 240
/** Room under the picture for the lines that say what it is. */
const TEXT_ROOM = 76
/** And for a hint under them. */
const HINT_ROOM = 18

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

/** "photo 2 of 3" (nothing for an asset's only photo); "voice", "voice 2" for its second voice clip. */
function placeOf(target: TokenTarget, ref: 'image' | 'audio'): string | undefined {
  const several = (target.count ?? 0) > 1 && target.number !== undefined
  if (ref === 'image') return several ? `photo ${target.number} of ${target.count}` : undefined
  if (!target.name) return undefined
  return `${audioRole(target.kind)}${several ? ` ${target.number}` : ''}`
}

/** "0:02–0:10 (8 s)", or "from 0:02" when the length isn't known. */
function windowText(window: { start: number; length?: number }): string {
  if (window.length !== undefined) return windowLabel({ start: window.start, length: window.length })
  const t = Math.max(0, Math.round(window.start))
  return `from ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

function ReferenceCard({
  id,
  ref,
  content,
  rect,
  onMouseEnter,
  onMouseLeave
}: {
  id: string
  ref: Ref<HTMLDivElement>
  content: TokenCardContent
  rect: DOMRect
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  const { token, target, problem } = content
  const picture = content.ref === 'image' && target?.path && !problem ? target.path : undefined
  const room = TEXT_ROOM + (content.hint ? HINT_ROOM : 0)
  const height = picture ? PICTURE + room : 96
  const place = placeBeside(rect, WIDTH, height, height)
  const tone = target?.kind ? KIND_TONE[target.kind].text : 'text-text'
  const where = target ? placeOf(target, content.ref) : undefined

  let body: ReactNode
  if (problem || !target) {
    body = <p className="leading-snug text-red-300">{problem ?? `${token} doesn’t point at anything that is sent.`}</p>
  } else if (content.ref === 'audio') {
    const w = target.window
    body = (
      <div className="flex items-center gap-2.5">
        {target.path && w?.length ? (
          <AudioPlayButton
            path={target.path}
            start={w.start}
            length={w.length}
            label={`${token} (${target.label})`}
            className="h-8 w-8"
            keepPlaying
          />
        ) : (
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised text-muted">
            ♪
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate">
            <span className={`font-medium ${tone}`}>{token}</span>
            <span className="text-muted"> · </span>
            <span className="font-medium">{target.name ?? 'Own sound'}</span>
          </span>
          <span className="block truncate text-[11px] text-muted">
            {[where ?? (target.path ? fileName(target.path) : undefined), w ? windowText(w) : undefined]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {target.unsent && <span className="block text-[11px] leading-snug text-accent">{target.unsent}</span>}
        </span>
      </div>
    )
  } else {
    body = (
      <>
        {picture && (
          <CardPicture
            path={picture}
            dim={!!target.unsent}
            maxHeight={Math.max(60, Math.min(PICTURE, place.maxHeight - room))}
          />
        )}
        <p className="mt-1.5 flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">
            <span className={`font-medium ${tone}`}>{token}</span>
            <span className="text-muted"> · </span>
            <span className="font-medium">{target.name ?? (target.path ? fileName(target.path) : target.label)}</span>
          </span>
          {target.kind && (
            <span className={`shrink-0 text-[11px] ${KIND_TONE[target.kind].text}`}>{ASSET_COPY[target.kind].singular}</span>
          )}
        </p>
        {(where || (!target.name && target.path)) && (
          <p className="text-[11px] text-muted">{where ?? 'own image'}</p>
        )}
        {target.unsent && <p className="text-[11px] leading-snug text-accent">{target.unsent}</p>}
        {content.hint && <p className="mt-0.5 text-[11px] leading-snug text-muted">{content.hint}</p>}
      </>
    )
  }

  // A picture's card has nothing to reach: the pointer goes through it, so it never covers a neighbour's ✕ or a drop.
  const through = content.ref === 'image'
  return createPortal(
    <div
      id={id}
      ref={ref}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // no-drag: near the top it can lie over a title-bar drag region.
      className={`no-drag fixed z-[70] flex flex-col overflow-hidden rounded-lg border border-line bg-panel p-2 text-[12px] text-text shadow-2xl shadow-black/60 ${
        through ? 'pointer-events-none' : ''
      }`}
      style={{ top: place.top, bottom: place.bottom, left: place.left, width: WIDTH, maxHeight: place.maxHeight }}
    >
      {body}
    </div>,
    document.body
  )
}

/** The picture, whole (contained, its long side at most PICTURE px). */
function CardPicture({ path, dim, maxHeight }: { path: string; dim: boolean; maxHeight: number }) {
  const [missing, setMissing] = useState(false)
  if (missing) {
    return (
      <span className="flex h-16 items-center justify-center rounded bg-raised px-2 text-center text-[11px] text-accent">
        The image file no longer exists
      </span>
    )
  }
  return (
    <span className="flex min-h-16 items-center justify-center overflow-hidden rounded bg-black/40">
      <img
        src={mediaUrl(path)}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => setMissing(true)}
        className={`max-w-full object-contain ${dim ? 'opacity-50' : ''}`}
        style={{ maxHeight }}
      />
    </span>
  )
}
