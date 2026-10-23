import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type Ref, type RefObject } from 'react'
import type { Asset, Still } from '@shared/types'
import { fileName } from '../lib/library'
import { mediaUrl } from '../lib/media'
import { useSeenPictureWhenVisible } from '../lib/work'
import { assetsByPath } from './pickers/assetRefs'
import { possessive } from './pickers/audioRefs'
import Popover from './pickers/Popover'
import { useTokenCard, type TokenCardContent } from './pickers/ReferenceCard'
import { moveItem } from './pickers/reorder'
import { SwapAssetPicker, SwapImagePicker } from './pickers/SwapPicker'
import { occurrenceKeys, reorderHint, useReorder } from './pickers/useReorder'

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i
const NO_ASSETS: Asset[] = []

/** Drag payload of a reference image being moved within its strip (its key). */
export const REFERENCE_IMAGE_DRAG_TYPE = 'application/x-studio-reference-image'

/** What takes a clicked picture's place: another picture, or (every place of its asset) another asset. */
export type SwapChoice = { kind: 'image'; path: string } | { kind: 'asset'; assetId: string }

/** A label on a thumbnail, e.g. the library asset the photo belongs to. */
export interface ImageCaption {
  text: string
  /** Background of the name strip (e.g. the asset kind's colour); defaults to a dark strip. */
  className?: string
}

interface Props {
  label: string
  hint?: string
  multiple?: boolean
  max?: number
  value: string[]
  /**
   * The new list: images added or removed, or (multiple) the same images in a new order after a drag or ⌥← / ⌥→
   * – one call per change, so a parent that renumbers the prompt's @ImageN tokens does it in the same update.
   */
  onChange: (paths: string[]) => void
  /** Extra controls in the header row, e.g. library picker buttons. */
  action?: ReactNode
  /** Short label on a thumbnail, e.g. the character or environment the image belongs to. */
  caption?: (path: string) => ImageCaption | string | undefined
  /** Show "n/max" in the header (multiple only); off when the form shows the image budget elsewhere. */
  showCount?: boolean
  /**
   * An optional single image: while there is none, the drop zone is one line ("Drop an end image or click") instead
   * of a thumbnail's height, so it doesn't push the rest of a long form down.
   */
  compact?: boolean
  /** Whether several images can be put in another order by dragging them (multiple only). Default true. */
  reorderable?: boolean
  /** The library: names a picture on its hover card and is what the swap picker offers. */
  library?: Asset[]
  /** Saved pictures the swap picker offers; left out, it lists them itself (`sequenceId`'s, or all of them). */
  stills?: Still[]
  sequenceId?: string
  /**
   * Swaps the picture at `index` (0-based) in place, so its number and the prompt's tokens stay (the parent says what
   * the swap did). With it, a click on a library photo (multiple) offers another asset for every place of its asset.
   * Left out, a swap is an ordinary change through onChange.
   */
  onSwap?: (index: number, choice: SwapChoice) => void
  /**
   * Gets the dropped files that aren't pictures (a video, a document) instead of their being ignored, so the form can
   * put a video where it belongs or say why a file can't be used. Left out, they are ignored.
   */
  onOtherFiles?: (paths: string[]) => void
}

/** The swap picker: for the picture with this key (it follows the picture when the list changes meanwhile). */
interface Swapping {
  key: string
  /** Another asset for every place of the picture's asset, or another picture for this place only. */
  mode: 'asset' | 'image'
}

/**
 * Drop zone + thumbnails for one or more local images. With several, the order is the @ImageN order: drag a
 * thumbnail to another place (or focus it and press ⌥← / ⌥→) and the numbers follow. Images past `max` stay
 * visible but are marked as not sent – moving one in front pushes the last one that was sent out. Hovering a
 * thumbnail shows it larger with what it is; a click (not the end of a drag) or Enter / Space swaps it in place: a
 * library photo for another asset everywhere its asset is (with onSwap), any other picture for another picture.
 */
export default function ImageInput({
  label,
  hint,
  multiple = false,
  max = 1,
  value,
  onChange,
  action,
  caption,
  showCount = true,
  compact = false,
  reorderable = true,
  library = NO_ASSETS,
  stills,
  sequenceId,
  onSwap,
  onOtherFiles
}: Props) {
  const [over, setOver] = useState(false)
  const [swapping, setSwapping] = useState<Swapping>()
  // Whether the press that ends in a click started a drag (a reorder): that click doesn't open the swap picker.
  const dragged = useRef(false)
  // Remembered images can point at files that were deleted since (e.g. a removed character photo).
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  const keys = occurrenceKeys(value)
  const byPath = useMemo(() => assetsByPath(library), [library])
  const card = useTokenCard()

  const reorder = useReorder({
    type: REFERENCE_IMAGE_DRAG_TYPE,
    keys,
    onMove: multiple && reorderable ? (from, to) => onChange(moveItem(value, from, to)) : undefined,
    describeMove: (_, to) => {
      const sent = to < max
      return (
        `The image moved to place ${to + 1} of ${value.length}` +
        (sent ? ` and is now @Image${to + 1}.` : ` and isn’t sent – the model takes at most ${max} images.`)
      )
    }
  })

  // Several: added only into free places. A list already at (or past) the limit keeps every picture it has – the
  // ones marked "not sent" are kept on purpose (moved forward to be sent), never cut off by an addition.
  const room = multiple ? Math.max(0, max - value.length) : 1

  const add = (paths: string[]) => {
    const images = paths.filter((p) => IMAGE_EXT.test(p))
    if (!images.length) return
    if (!multiple) return onChange(images.slice(0, 1))
    const fresh = images.filter((p, i) => !value.includes(p) && images.indexOf(p) === i).slice(0, room)
    if (fresh.length) onChange([...value, ...fresh])
  }

  // Only files dragged in from outside light up the drop zone; a thumbnail being moved shows its marker instead.
  const carriesFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

  const onDragOver = (e: DragEvent) => {
    if (reorder.onDragOver(e)) return
    // Anything else (an audio chip, a still, text) can't be dropped here, nor files on a full strip (unless the parent
    // takes the files that aren't pictures), and the cursor should say so.
    if (!carriesFiles(e) || (!room && !onOtherFiles)) return
    e.preventDefault()
    setOver(true)
  }

  const onDrop = (e: DragEvent) => {
    if (reorder.onDrop(e)) return
    e.preventDefault()
    setOver(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.studio.pathForFile(f))
    add(paths)
    const others = paths.filter((p) => !IMAGE_EXT.test(p))
    if (others.length) onOtherFiles?.(others)
  }

  const pick = async () => add(await window.studio.pickImages(multiple))

  // ── Swapping a picture in place ──────────────────────────────────────────────
  // What a single image is called on its card and in the picker: the label without its "(optional)".
  const place = label.replace(/\s*\(.*\)\s*$/, '')
  const list = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const swapIndex = swapping ? keys.indexOf(swapping.key) : -1
  // A picture that left the list (removed, or swapped by an agent meanwhile) takes its picker along.
  useEffect(() => {
    if (swapping && swapIndex === -1) setSwapping(undefined)
  }, [swapping, swapIndex])
  /** The thumbnail of picture i, for focus after a swap (a swapped-in picture is a new element). */
  const thumbnail = (i: number) => list.current?.querySelectorAll<HTMLElement>(':scope > [tabindex="0"]')[i]
  // Every place of an asset can be swapped through onSwap only (in a list, where the prompt names the places).
  const wholeAsset = multiple && !!onSwap

  /** A click or Enter on thumbnail i: its picker, or (clicked again) none. */
  const openSwap = (i: number, el: HTMLElement) => {
    card.hide()
    const key = keys[i]
    if (swapping?.key === key) return setSwapping(undefined)
    anchor.current = el
    setSwapping({ key, mode: wholeAsset && byPath.has(value[i]) ? 'asset' : 'image' })
  }
  const closeSwap = () => setSwapping(undefined)
  // After a pick, focus goes to the picture now in that place (from the keyboard its card then says what it is) –
  // once the list shows it: a swapped-in picture is a new element.
  const focusAfterSwap = useRef<number | null>(null)
  useEffect(() => {
    const i = focusAfterSwap.current
    if (i === null) return
    focusAfterSwap.current = null
    thumbnail(i)?.focus({ preventScroll: true })
  })
  const settle = (i: number) => {
    closeSwap()
    focusAfterSwap.current = i
  }

  /** Another picture in place i: through onSwap when given (the prompt keeps its tokens), else an ordinary change. */
  const swapImage = (i: number, path: string) => {
    settle(i)
    if (onSwap) onSwap(i, { kind: 'image', path })
    else onChange(multiple ? value.map((p, j) => (j === i ? path : p)) : [path])
  }
  /** Another asset in every place of picture i's asset. */
  const swapAsset = (i: number, to: Asset) => {
    settle(i)
    onSwap?.(i, { kind: 'asset', assetId: to.id })
  }

  /** Place i as the card and the picker name it: "@Image2", "Image 5" past the limit, "Start image" for a single one. */
  const nameOf = (i: number): string => (!multiple ? place : i < max ? `@Image${i + 1}` : `Image ${i + 1}`)

  /** What thumbnail i's card says: its place, what it is and whether it is sent. */
  const cardOf = (p: string, at: number, overflow: boolean): TokenCardContent => {
    const asset = byPath.get(p)
    const photo = asset ? asset.images.findIndex((img) => img.path === p) + 1 : 0
    const what = wholeAsset && asset ? asset.name : 'the image'
    return {
      token: nameOf(at),
      ref: 'image',
      target: {
        kind: asset?.kind,
        label: asset ? `${asset.name} (photo ${photo})` : fileName(p),
        path: p,
        name: asset?.name,
        number: photo || undefined,
        count: asset?.images.length,
        ...(overflow ? { unsent: `Not sent – the model takes at most ${max} images` } : {})
      },
      hint: `Click to swap ${what}${reorder.enabled ? ` – ${reorderHint()}` : ''}`
    }
  }

  const full = value.length >= (multiple ? max : 1)
  const dragging = reorder.dragging !== -1
  const overflowCount = multiple ? Math.max(0, value.length - max) : 0
  const oneLine = compact && !multiple && !value.length

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="shrink-0 whitespace-nowrap text-muted">{label}</span>
        <span className="flex items-center gap-2">
          {action}
          {multiple && showCount && (
            <span className={`text-[11px] ${value.length > max ? 'text-danger' : 'text-muted'}`}>
              {value.length}/{max}
            </span>
          )}
        </span>
      </div>
      <div
        ref={list}
        role={multiple ? 'list' : undefined}
        aria-label={
          multiple ? `${label}${reorder.enabled ? ` – ${reorderHint()}` : ''}` : undefined
        }
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          reorder.onDragLeave(e)
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={onDrop}
        className={`flex flex-wrap gap-2 rounded-md border border-dashed transition ${oneLine ? 'p-1' : 'p-2'} ${
          over ? 'border-accent bg-accent/5' : dragging ? 'border-muted/60' : 'border-line'
        }`}
      >
        {value.map((p, i) => {
          // While dragging, every thumbnail shows the number (and sent state) it would have after the drop.
          const at = reorder.positions[i] ?? i
          const overflow = multiple && at >= max
          const renamed = dragging && at !== i
          const raw = caption?.(p)
          const cap = typeof raw === 'string' ? { text: raw } : raw
          const name = fileName(p)
          const isMissing = missing.has(p)
          const { ref, onDragStart, onKeyDown, ...item } = reorder.itemProps(i)
          const shown = cap?.text ?? name ?? p
          const picked = swapping?.key === keys[i]
          // The card shows the picture larger on hover – not while a picture is dragged or a picker is open.
          const hover = dragging || swapping ? undefined : card.hover(i, cardOf(p, at, overflow))
          return (
            <div
              key={keys[i]}
              ref={ref as Ref<HTMLDivElement>}
              {...item}
              {...hover}
              onMouseDown={() => {
                dragged.current = false
                card.hide()
              }}
              onDragStart={(e) => {
                dragged.current = true
                card.hide()
                onDragStart?.(e)
              }}
              onClick={(e) => {
                // A click swaps it; not the end of a drag (which normally fires none), nor a click on the ✕.
                if (dragged.current || (e.target as HTMLElement).closest('button')) return
                openSwap(i, e.currentTarget)
              }}
              onKeyDown={(e) => {
                onKeyDown?.(e)
                if (e.defaultPrevented || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                openSwap(i, e.currentTarget)
              }}
              role={multiple ? 'listitem' : 'button'}
              tabIndex={0}
              aria-haspopup="dialog"
              aria-expanded={picked}
              aria-label={
                multiple
                  ? `${overflow ? 'Not sent' : `@Image${at + 1}`}: ${shown}. Enter swaps it` +
                    (reorder.enabled ? `; ${reorderHint()}.` : '.')
                  : `${label}: ${shown}. Enter swaps it.`
              }
              className={`group relative h-16 w-16 shrink-0 rounded bg-raised outline-none ring-offset-2 ring-offset-panel transition focus-visible:ring-2 focus-visible:ring-muted ${
                reorder.enabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
              } ${picked ? 'ring-2 ring-text' : isMissing ? 'ring-1 ring-accent' : ''} ${reorder.dragging === i ? 'opacity-30' : ''}`}
            >
              <div className={`h-full w-full overflow-hidden rounded ${overflow ? 'opacity-40' : ''}`}>
                {isMissing ? (
                  <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-danger">
                    File missing
                  </span>
                ) : (
                  <>
                    <img
                      src={mediaUrl(p)}
                      alt=""
                      draggable={false}
                      onError={() => setMissing((s) => new Set(s).add(p))}
                      className="pointer-events-none h-full w-full object-cover"
                    />
                    <SeenWhenShown path={p} />
                  </>
                )}
                {cap && (
                  <span
                    className={`absolute inset-x-0 bottom-0 truncate rounded-b px-1 text-center text-[10px] text-white ${
                      cap.className ?? 'bg-black/70'
                    }`}
                  >
                    {cap.text}
                  </span>
                )}
              </div>
              {multiple &&
                (overflow ? (
                  <span className="absolute left-1 top-1 rounded bg-black/80 px-1 text-[9px] leading-[14px] text-danger">
                    not sent
                  </span>
                ) : (
                  <span
                    className={`absolute left-1 top-1 rounded px-1 text-[10px] ${
                      renamed ? 'bg-text text-bg' : 'bg-black/70'
                    }`}
                  >
                    @Image{at + 1}
                  </span>
                ))}
              <button
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                draggable={false}
                // Shown on hover and on keyboard focus (of the thumbnail, then of itself when tabbed to), not after a
                // click or drag, where it would only cover the @ImageN badge. Hidden by opacity, not display: a
                // button that is display:none while focus moves onto it can't take the focus, and Tab would get lost.
                className={`pointer-events-none absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] opacity-0 outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-text ${
                  dragging
                    ? ''
                    : 'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:opacity-100'
                }`}
                title="Remove"
                aria-label={`Remove ${cap?.text ?? name ?? 'the image'}`}
              >
                ✕
              </button>
              {reorder.gap === i && <DropMarker side="before" />}
              {reorder.gap === value.length && i === value.length - 1 && <DropMarker side="after" />}
            </div>
          )
        })}
        {!full && (
          <button
            type="button"
            onClick={pick}
            className={`flex min-w-16 flex-1 items-center justify-center rounded text-muted hover:bg-raised hover:text-text ${
              oneLine ? 'h-8 text-[12px]' : 'h-16'
            }`}
          >
            {value.length
              ? '+'
              : oneLine
                ? `Drop ${article(place)} ${place.toLocaleLowerCase('en')} or click`
                : 'Drop an image here or click'}
          </button>
        )}
      </div>
      {overflowCount > 0 && (
        <p className="mt-1 text-[11px] text-danger">
          {overflowCount === 1 ? 'The last image isn’t' : `The last ${overflowCount} images aren’t`} sent – the model takes
          at most {max}.{reorder.enabled && ' Drag an image further forward to send it instead.'}
        </p>
      )}
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
      <span className="sr-only" aria-live="polite">
        {reorder.announcement}
      </span>
      {card.card}
      <SwapPopover
        open={swapIndex !== -1}
        anchorRef={anchor}
        onClose={closeSwap}
        mode={swapping?.mode ?? 'image'}
        index={swapIndex}
        values={value}
        nameOf={nameOf}
        library={library}
        byPath={byPath}
        stills={stills}
        sequenceId={sequenceId}
        wholeAsset={wholeAsset}
        onMode={(mode) => setSwapping((cur) => cur && { ...cur, mode })}
        onPickImage={(path) => swapImage(swapIndex, path)}
        onPickAsset={(to) => swapAsset(swapIndex, to)}
      />
    </div>
  )
}

/**
 * The picker a clicked thumbnail opens, anchored to it. A library photo in a list (`wholeAsset`): another asset for
 * every place of its asset – a character's outfit, voice, poses and products follow (shared/reference-swap) – with
 * "Pick a single image instead…" for this place only. Any other picture: another picture for its place.
 */
function SwapPopover({
  open,
  anchorRef,
  onClose,
  mode,
  index,
  values,
  nameOf,
  library,
  byPath,
  stills,
  sequenceId,
  wholeAsset,
  onMode,
  onPickImage,
  onPickAsset
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  mode: Swapping['mode']
  /** The picture swapped (its index in `values`). */
  index: number
  values: readonly string[]
  nameOf: (i: number) => string
  library: readonly Asset[]
  byPath: ReadonlyMap<string, Asset>
  stills?: Still[]
  sequenceId?: string
  wholeAsset: boolean
  onMode: (mode: Swapping['mode']) => void
  onPickImage: (path: string) => void
  onPickAsset: (to: Asset) => void
}) {
  const path = values[index]
  const asset = path === undefined ? undefined : byPath.get(path)
  const present = useMemo(() => new Set(values.flatMap((p) => byPath.get(p)?.id ?? [])), [values, byPath])
  const place = index === -1 ? '' : nameOf(index)
  const placeOf = (p: string): string | undefined => {
    const at = values.indexOf(p)
    return at === -1 ? undefined : nameOf(at)
  }
  const whole = wholeAsset && mode === 'asset' && asset
  // "start image" in a sentence, "@Image2" as it is.
  const inText = place.startsWith('@') ? place : place.charAt(0).toLowerCase() + place.slice(1)

  let body: ReactNode = null
  if (open && path !== undefined && whole) {
    const places = values.flatMap((p, i) => (byPath.get(p)?.id === asset.id ? [nameOf(i)] : []))
    const follows =
      asset.kind === 'character'
        ? ` ${possessive(asset.name, 'en')} outfits, voice, poses and products come along.`
        : asset.audio.length
          ? ' If both have sound, it is swapped too.'
          : ''
    body = (
      <SwapAssetPicker
        title={`Swap ${asset.name} for…`}
        hint={`Every place ${asset.name} is in (${places.join(', ')}) gets the new one – the numbers in the prompt stay the same.${follows}`}
        library={library}
        from={asset}
        present={present}
        alternative={{
          label: 'Pick a single image instead…',
          title: `Swap only ${inText}, not ${possessive(asset.name, 'en')} other places`,
          onClick: () => onMode('image')
        }}
        onPick={onPickAsset}
        onClose={onClose}
      />
    )
  } else if (open && path !== undefined) {
    body = (
      <SwapImagePicker
        title={`Swap ${inText} for…`}
        hint={values.length > 1 ? 'Only this place is swapped – the number and the prompt stay.' : undefined}
        library={library}
        current={path}
        currentKind={asset?.kind}
        placeOf={placeOf}
        stills={stills}
        sequenceId={sequenceId}
        alternative={
          wholeAsset && asset
            ? { label: `Swap all of ${asset.name} instead…`, onClick: () => onMode('asset') }
            : undefined
        }
        onPick={onPickImage}
        onClose={onClose}
      />
    )
  }
  return (
    <Popover anchorRef={anchorRef} open={open && !!body} onClose={onClose} width={360} maxHeight={480} label={`Swap ${inText}`}>
      {body}
    </Popover>
  )
}

/** "a" or "an" before a word (in English UI text): "an end image", "a start image". */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

/**
 * Covers a thumbnail: a picture the user hasn't seen yet (one an agent made for this clip, say) counts as seen once it
 * has been on screen here a moment, as it would in its viewer.
 */
function SeenWhenShown({ path }: { path: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useSeenPictureWhenVisible(ref, path)
  return <span ref={ref} aria-hidden className="pointer-events-none absolute inset-0" />
}

/** The insertion marker in the gap before (or after) a thumbnail, centred in the 8 px gap. */
function DropMarker({ side }: { side: 'before' | 'after' }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute -inset-y-1 w-0.5 rounded-full bg-accent ${
        side === 'before' ? '-left-[5px]' : '-right-[5px]'
      }`}
    />
  )
}
