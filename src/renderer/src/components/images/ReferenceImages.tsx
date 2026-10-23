import { useEffect, useMemo, useRef, useState, type DragEvent, type Ref } from 'react'
import type { Asset, AssetKind, ReferenceKind, Still } from '@shared/types'
import { fileName } from '../../lib/library'
import { mediaUrl } from '../../lib/media'
import AssetPicker from '../pickers/AssetPicker'
import { KIND_TONE } from '../pickers/assetKinds'
import { assetsByPath } from '../pickers/assetRefs'
import Popover from '../pickers/Popover'
import { useTokenCard, type TokenCardContent } from '../pickers/ReferenceCard'
import { SwapImagePicker } from '../pickers/SwapPicker'
import { reorderHint, useReorder } from '../pickers/useReorder'
import { stillSourceLabel } from './imageModels'
import StillThumb, { isStillDrag, stillIdFromDrop } from './StillThumb'

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i
/** Reordering inside the list (the index being dragged); kept apart from stills and files dropped from outside. */
const REORDER_TYPE = 'application/x-studio-reference-index'

const smallButton =
  'whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40'
/** A picture offered with one click under the list (the clip's references, the previous board's image). */
const offerButton =
  'rounded-md border border-line px-2 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-text'

/** Tab order of the library picker: who is in the picture comes first. */
const FIRST_KIND: ReferenceKind = 'character'

/** Whose stills the picker offers: a sequence's, a storyboard's, or (undefined) every saved picture. */
export type StillsOwner = 'sequence' | 'storyboard'

/** The stills picker's wording for each owner. */
const STILLS_COPY: Record<StillsOwner | 'all', { name: string; title: string; gone: string }> = {
  sequence: {
    name: 'Sequence images',
    title: 'Images and frames in the sequence',
    gone: "The image is no longer among the sequence's images."
  },
  storyboard: {
    name: 'Storyboard images',
    title: 'Images and frames in the storyboard',
    gone: "The image is no longer among the storyboard's images."
  },
  all: { name: 'Saved images', title: 'Saved images', gone: 'The image is no longer among the saved images.' }
}

/** "1 image", "3 images". */
const images = (n: number): string => `${n} ${n === 1 ? 'image' : 'images'}`

interface Props {
  /** Absolute paths, in the order they are sent: the first is the base the others are combined into. */
  value: string[]
  onChange: (paths: string[]) => void
  /** How many images the model takes; the ones after it are shown but not sent. */
  max: number
  /** Every library asset (all kinds), for the picker and the name captions. */
  assets: Asset[]
  /** The stills that can be picked (the sequence's or storyboard's, newest first). */
  stills: Still[]
  /** Whose the stills are (wording of the picker); undefined: every saved picture. */
  stillsOf?: StillsOwner
  /** Captions that name a picture by its role, e.g. "Previous" for the previous board's image; win over others. */
  pathLabels?: Record<string, string>
  /** The clip's own reference images, offered with one click (a keyframe usually shows the same people). */
  clipReferences?: string[]
  clipNumber?: number
  /** Something couldn't be added (too many); cleared by the next change. */
  onNote: (note: string | undefined) => void
  /** Opens a library view, e.g. to create a character. Closes the dialog first. */
  onManage?: (kind: AssetKind) => void
  /**
   * Reports whether a picker is open, so the dialog around it can leave Escape and outside clicks to the
   * picker (which closes on them) instead of closing itself as well.
   */
  onPickerOpen?: (open: boolean) => void
  /**
   * One more picture offered under the list with a click of its own, e.g. "＋ Previous board's image" after its ✕
   * took it out: its own callback, since it may go in first (as the base) rather than at the end.
   */
  offer?: { label: string; title: string; onAdd: () => void }
}

type Picker = 'library' | 'stills'

/**
 * The reference images of a still: thumbnails in send order (the first is the base), with pickers for the
 * library (characters, environments, products, outfits, poses) and the sequence's stills, a file dialog, drag and
 * drop of files and stills, and drag (or ⌥← / ⌥→) to reorder. Hovering a thumbnail shows it larger; a click on it (or
 * Enter / Space) opens a picker anchored to it that puts another picture in the same place.
 */
export default function ReferenceImages({
  value,
  onChange,
  max,
  assets,
  stills,
  stillsOf,
  pathLabels,
  clipReferences = [],
  clipNumber,
  onNote,
  onManage,
  onPickerOpen,
  offer
}: Props) {
  const [picker, setPicker] = useState<Picker | null>(null)
  // The picture whose swap picker is open (its path: it follows the picture if the order changes meanwhile).
  const [swapping, setSwapping] = useState<string>()
  // Whether the press that ends in a click started a drag (a reorder): that click doesn't open the swap picker.
  const dragged = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const swapAnchor = useRef<HTMLElement | null>(null)
  const swapIndex = swapping === undefined ? -1 : value.indexOf(swapping)
  // The swap picker counts as a picker: Escape and clicks in it are its own, not the dialog's.
  useEffect(() => onPickerOpen?.(picker !== null || swapIndex !== -1), [picker, swapIndex !== -1])
  const card = useTokenCard()
  const libraryButton = useRef<HTMLButtonElement>(null)
  const stillsButton = useRef<HTMLButtonElement>(null)
  const [over, setOver] = useState(false)
  const [dragIndex, setDragIndex] = useState<number>()
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())

  const byPath = useMemo(() => assetsByPath(assets), [assets])
  const stillByPath = useMemo(() => new Map(stills.map((s) => [s.path, s])), [stills])
  const stillById = useMemo(() => new Map(stills.map((s) => [s.id, s])), [stills])
  const copy = STILLS_COPY[stillsOf ?? 'all']

  /** Adds images after the ones there (duplicates skipped), as many as the model takes. */
  const add = (paths: string[]) => {
    if (paths.length && !paths.some((p) => IMAGE_EXT.test(p))) {
      onNote('Only JPG, PNG or WebP images can be used.')
      return
    }
    const fresh = paths.filter((p, i) => IMAGE_EXT.test(p) && !value.includes(p) && paths.indexOf(p) === i)
    if (!fresh.length) return
    const room = Math.max(0, max - value.length)
    onNote(
      fresh.length > room
        ? room
          ? `Only ${room === 1 ? 'one more image' : `${room} more images`} fit – the model takes up to ${max}.`
          : `The model takes up to ${images(max)}. Remove one to add another.`
        : undefined
    )
    if (room) onChange([...value, ...fresh.slice(0, room)])
  }

  /** Picking an image that is already there takes it out again, so the pickers work as toggles. */
  const toggle = (path: string) => {
    if (value.includes(path)) {
      onNote(undefined)
      onChange(value.filter((p) => p !== path))
    } else add([path])
  }

  const remove = (i: number) => {
    onNote(undefined)
    onChange(value.filter((_, j) => j !== i))
  }

  const move = (from: number, to: number) => {
    if (from === to || from < 0 || from >= value.length) return
    const next = value.slice()
    const [moved] = next.splice(from, 1)
    next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
    onChange(next)
  }

  // ⌥← / ⌥→ on a thumbnail moves it one place, as everywhere a list can be reordered; dragging stays this list's own
  // (it also takes stills and files), so only the keyboard move, its focus and its announcement come from the hook.
  const reorder = useReorder({
    type: REORDER_TYPE,
    keys: value,
    onMove: move,
    describeMove: (_, to) =>
      `The image moved to place ${to + 1} of ${value.length}${to === 0 ? ' and is now the base image' : ''}.`
  })

  const acceptsDrop = (e: DragEvent) =>
    isStillDrag(e) || Array.from(e.dataTransfer.types).includes('Files') || e.dataTransfer.types.includes(REORDER_TYPE)

  const onDrop = (e: DragEvent, at?: number) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    const reorder = e.dataTransfer.getData(REORDER_TYPE)
    if (reorder !== '') {
      move(Number(reorder), at ?? value.length - 1)
      return
    }
    const stillId = stillIdFromDrop(e)
    if (stillId) {
      const still = stillById.get(stillId)
      if (still) add([still.path])
      else onNote(copy.gone)
      return
    }
    add(Array.from(e.dataTransfer.files).map((f) => window.studio.pathForFile(f)))
  }

  const pickFiles = async () => add(await window.studio.pickImages(true))

  /** A click or Enter on thumbnail i: its swap picker, or (clicked again) none. */
  const openSwap = (i: number, el: HTMLElement) => {
    card.hide()
    if (swapping === value[i]) return setSwapping(undefined)
    swapAnchor.current = el
    setSwapping(value[i])
  }

  /**
   * The picture picked in the swap picker takes place i, the order (and so "image 2" in the prompt) stays. A picture
   * already among the references isn't added twice.
   */
  const swap = (i: number, path: string) => {
    setSwapping(undefined)
    if (!IMAGE_EXT.test(path)) return onNote('Only JPG, PNG or WebP images can be used.')
    if (value.some((p, j) => j !== i && p === path)) return onNote('The image is already among the reference images.')
    onNote(undefined)
    onChange(value.map((p, j) => (j === i ? path : p)))
    focusAfterSwap.current = i
  }
  // Then focus on the picture now in that place, once the list shows it (the thumbnails are keyed by their file).
  const focusAfterSwap = useRef<number | null>(null)
  useEffect(() => {
    const i = focusAfterSwap.current
    if (i === null) return
    focusAfterSwap.current = null
    list.current?.querySelectorAll<HTMLElement>(':scope > [role=listitem]')[i]?.focus({ preventScroll: true })
  })

  const place = (i: number): string => (i === 0 ? 'Base image' : `Image ${i + 1}`)

  /** What thumbnail i's hover card says: its place, what it is (a photo, a role, a still) and whether it is sent. */
  const cardOf = (path: string, i: number): TokenCardContent => {
    const asset = byPath.get(path)
    const still = stillByPath.get(path)
    const photo = asset ? asset.images.findIndex((img) => img.path === path) + 1 : 0
    return {
      token: place(i),
      ref: 'image',
      target: {
        kind: asset?.kind,
        label: asset?.name ?? fileName(path),
        path,
        name: pathLabels?.[path] ?? asset?.name ?? (still ? stillSourceLabel(still) : undefined),
        number: photo || undefined,
        count: asset?.images.length,
        ...(i >= max ? { unsent: `Not sent – the model takes up to ${images(max)}` } : {})
      },
      hint: `Click to swap the image – ${reorderHint()}`
    }
  }

  const clipMissing = clipReferences.filter((p) => !value.includes(p))
  const overflow = value.length > max

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-muted">
          Reference images
          {value.length > 0 && (
            <span className={`ml-1.5 text-[11px] ${overflow ? 'text-danger' : ''}`}>
              {value.length}/{max}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center justify-end">
          <button
            ref={libraryButton}
            onClick={() => setPicker((p) => (p === 'library' ? null : 'library'))}
            className={`${smallButton} ${picker === 'library' ? 'bg-raised text-text' : ''}`}
            title={
              'Characters, environments, products, outfits and poses – with reference images, the model combines ' +
              'them into a new image (a character in an environment, in an outfit and pose, holding a product)'
            }
          >
            From the library
          </button>
          <button
            ref={stillsButton}
            onClick={() => setPicker((p) => (p === 'stills' ? null : 'stills'))}
            className={`${smallButton} ${picker === 'stills' ? 'bg-raised text-text' : ''}`}
            title={copy.title}
          >
            {copy.name}
          </button>
          <button onClick={() => void pickFiles()} className={smallButton} title="Choose image files on your computer">
            From file…
          </button>
        </span>
      </div>

      <div
        ref={list}
        role="list"
        aria-label={`Reference images${reorder.enabled ? ` – ${reorderHint()}` : ''}`}
        onDragOver={(e) => {
          if (!acceptsDrop(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes(REORDER_TYPE) ? 'move' : 'copy'
          setOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={(e) => onDrop(e)}
        className={`flex min-h-[84px] flex-wrap gap-2 rounded-md border border-dashed p-2 transition ${
          over ? 'border-accent bg-accent/5' : 'border-line'
        }`}
      >
        {value.map((path, i) => {
          const asset = byPath.get(path)
          const still = stillByPath.get(path)
          const notSent = i >= max
          const name = fileName(path)
          const role = pathLabels?.[path]
          const caption = role
            ? { text: role, className: 'bg-black/70' }
            : asset
              ? { text: asset.name, className: KIND_TONE[asset.kind].caption }
              : still
                ? { text: still.source === 'frame' ? 'Frame' : 'Image', className: 'bg-black/70' }
                : undefined
          const picked = swapping === path
          // The card shows the picture larger on hover – not while a picture is dragged or a picker is open.
          const hover = dragIndex !== undefined || swapIndex !== -1 ? undefined : card.hover(i, cardOf(path, i))
          const { ref, onKeyDown: moveKeys } = reorder.itemProps(i)
          return (
            <div
              key={path}
              ref={ref as Ref<HTMLDivElement>}
              role="listitem"
              tabIndex={0}
              aria-label={`${place(i)}: ${caption?.text ?? name}. Enter swaps it${reorder.enabled ? `; ${reorderHint()}` : ''}.`}
              aria-haspopup="dialog"
              aria-expanded={picked}
              draggable
              {...hover}
              onMouseDown={() => {
                dragged.current = false
                card.hide()
              }}
              onDragStart={(e) => {
                dragged.current = true
                card.hide()
                e.dataTransfer.setData(REORDER_TYPE, String(i))
                e.dataTransfer.effectAllowed = 'move'
                setDragIndex(i)
              }}
              onDragEnd={() => setDragIndex(undefined)}
              onDragOver={(e) => {
                if (!acceptsDrop(e)) return
                e.preventDefault()
              }}
              onDrop={(e) => onDrop(e, i)}
              onClick={(e) => {
                // A click swaps it; not the end of a drag, nor a click on ✕ or "Make base".
                if (dragged.current || (e.target as HTMLElement).closest('button')) return
                openSwap(i, e.currentTarget)
              }}
              onKeyDown={(e) => {
                moveKeys?.(e)
                if (e.defaultPrevented || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                openSwap(i, e.currentTarget)
              }}
              className={`group relative h-[66px] w-[66px] cursor-grab overflow-hidden rounded bg-raised outline-none ring-offset-2 ring-offset-panel focus-visible:ring-2 focus-visible:ring-muted active:cursor-grabbing ${
                notSent ? 'opacity-40' : ''
              } ${
                picked ? 'ring-2 ring-text' : missing.has(path) ? 'ring-1 ring-accent' : i === 0 ? 'ring-1 ring-accent/70' : ''
              } ${dragIndex === i ? 'opacity-50' : ''}`}
            >
              {missing.has(path) ? (
                <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-danger">
                  File missing
                </span>
              ) : (
                <img
                  src={mediaUrl(path)}
                  alt=""
                  draggable={false}
                  decoding="async"
                  onError={() => setMissing((s) => new Set(s).add(path))}
                  className="h-full w-full object-cover"
                />
              )}
              <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px]">
                {i === 0 ? 'Base' : i + 1}
              </span>
              {caption && (
                <span
                  className={`pointer-events-none absolute inset-x-0 bottom-0 truncate px-1 text-center text-[10px] text-white ${caption.className}`}
                >
                  {caption.text}
                </span>
              )}
              {/* Shown on hover and on keyboard focus (of the thumbnail, then of themselves when tabbed to). Hidden by
                  opacity, not display: a button that is display:none while focus moves onto it can't take the focus. */}
              <button
                type="button"
                onClick={() => remove(i)}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] opacity-0 outline-none group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-text"
                title="Remove"
                aria-label={`Remove ${place(i).toLocaleLowerCase('en')}`}
              >
                ✕
              </button>
              {i > 0 && (
                <button
                  type="button"
                  onClick={() => move(i, 0)}
                  className="absolute bottom-4 left-1/2 block -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 text-[10px] opacity-0 outline-none group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-text"
                  title="Make it the base image (sent first)"
                >
                  Make base
                </button>
              )}
            </div>
          )
        })}
        {value.length < max && (
          <button
            onClick={() => void pickFiles()}
            className="flex min-h-[66px] min-w-[66px] flex-1 items-center justify-center rounded px-3 text-center text-[12px] leading-relaxed text-muted hover:bg-raised hover:text-text"
          >
            {value.length
              ? '+'
              : 'No reference images – the image is created from the prompt alone. Drop images here or choose above.'}
          </button>
        )}
      </div>

      {(clipMissing.length > 0 || offer) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {offer && (
            <button type="button" onClick={offer.onAdd} className={offerButton} title={offer.title}>
              {offer.label}
            </button>
          )}
          {clipMissing.length > 0 && (
            <button
              type="button"
              onClick={() => add(clipMissing)}
              className={offerButton}
              title="The same characters, environments, products, outfits and poses the clip uses"
            >
              ＋ {clipNumber ? `Clip ${clipNumber}'s` : "The clip's"} reference images ({clipMissing.length})
            </button>
          )}
        </div>
      )}
      {/* The Base badge and the numbers show the order; how to use it only once there is an order. */}
      {value.length > 1 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          Refer to them in the prompt as “image 2”, “image 3” … – {reorderHint()}.
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {reorder.announcement}
      </span>

      {card.card}
      <Popover
        anchorRef={swapAnchor}
        open={swapIndex !== -1}
        onClose={() => setSwapping(undefined)}
        width={360}
        maxHeight={480}
        label={`Swap ${swapIndex === -1 ? 'the image' : place(swapIndex).toLocaleLowerCase('en')}`}
      >
        {swapIndex !== -1 && (
          <SwapImagePicker
            title={`Swap ${place(swapIndex).toLocaleLowerCase('en')} for…`}
            hint="The image is swapped in the same place in the order, so the prompt doesn't need to change."
            library={assets}
            current={value[swapIndex]}
            currentKind={byPath.get(value[swapIndex])?.kind}
            placeOf={(path) => {
              const at = value.indexOf(path)
              return at === -1 ? undefined : place(at)
            }}
            stills={stills}
            stillsLabel={copy.name}
            onPick={(path) => swap(swapIndex, path)}
            onClose={() => setSwapping(undefined)}
          />
        )}
      </Popover>

      <Popover
        anchorRef={libraryButton}
        open={picker === 'library'}
        onClose={() => setPicker(null)}
        align="end"
        width={340}
        maxHeight={480}
        label="Reference images from the library"
      >
        <AssetPicker
          assets={assets}
          initialKind={FIRST_KIND}
          title="From the library"
          hint={`Click an image to add or remove it – click the name for the cover image. Up to ${max}.`}
          selectedPaths={value}
          onPickImage={(path) => toggle(path)}
          onManage={
            onManage
              ? (kind) => {
                  setPicker(null)
                  onManage(kind)
                }
              : undefined
          }
        />
      </Popover>

      <Popover
        anchorRef={stillsButton}
        open={picker === 'stills'}
        onClose={() => setPicker(null)}
        align="end"
        width={360}
        maxHeight={420}
        label={copy.name}
      >
        <div className="border-b border-line px-3 py-2.5">
          <p className="font-medium">{copy.name}</p>
          <p className="mt-0.5 text-[11px] text-muted">Click to add or remove an image.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {stills.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-muted">
              No images yet. Images you create and frames you save from clips end up here.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {stills.map((s) => (
                <StillThumb
                  key={s.id}
                  still={s}
                  selected={value.includes(s.path)}
                  onOpen={() => toggle(s.path)}
                  className="aspect-video w-full"
                />
              ))}
            </div>
          )}
        </div>
      </Popover>
    </div>
  )
}
