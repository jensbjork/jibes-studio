import { useCallback, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type Ref } from 'react'
import { DEFAULT_MODEL, maxReferenceImages } from '@shared/models'
import type { Asset, AssetImage, AssetKind } from '@shared/types'
import { ASSET_COPY, originText } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import SectionTitle from '../library/SectionTitle'
import { reorderHint, useReorder } from '../pickers/useReorder'
import { CloseIcon, PlusIcon } from '../sequences/icons'
import ConfirmButton from '../ui/ConfirmButton'
import ImagePreview, { REMOVE_IMAGE_TITLE } from './ImagePreview'
import { imageIssues, insertIndex, type DropTarget, type Size } from './imageUtils'

/** In-app drags carry this type, so they can't be mistaken for files dropped from Finder. */
const DRAG_TYPE = 'application/x-studio-asset-image'
const MAX_REFERENCES = maxReferenceImages(DEFAULT_MODEL['reference-to-video'])

/** How the reference images are sent, for the tooltip of the line under the title (style frames say their own). */
const IMAGES_DETAIL =
  'The images come along in this order when you generate – they get their @Image numbers in Generate, after the ' +
  'images already there.'

// Places, and poses with people side by side, are mostly photographed wide; people and clothes upright; products
// as packshots, square; a director's style frames are film stills.
const LAYOUT: Record<AssetKind, { grid: string; tile: string }> = {
  character: { grid: 'grid-cols-[repeat(auto-fill,minmax(140px,1fr))]', tile: 'aspect-[3/4]' },
  environment: { grid: 'grid-cols-[repeat(auto-fill,minmax(190px,1fr))]', tile: 'aspect-[4/3]' },
  product: { grid: 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]', tile: 'aspect-square' },
  outfit: { grid: 'grid-cols-[repeat(auto-fill,minmax(140px,1fr))]', tile: 'aspect-[3/4]' },
  pose: { grid: 'grid-cols-[repeat(auto-fill,minmax(190px,1fr))]', tile: 'aspect-[4/3]' },
  // A director's style frames: stills from films, wide.
  director: { grid: 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]', tile: 'aspect-video' }
}

interface Props {
  asset: Asset
  /** Images currently being copied into the library. */
  adding: number
  /** Files from Finder are being dragged over the editor. */
  fileOver: boolean
  onAdd: (paths: string[]) => void
  onUpdated: (a: Asset) => void
  onError: (message: string) => void
}

/**
 * Reference photo grid: add, remove (it asks first), reorder (drag, ⌥← / ⌥→ on a focused tile, or "Make cover") and
 * size warnings.
 */
export default function AssetImages({ asset, adding, fileOver, onAdd, onUpdated, onError }: Props) {
  const copy = ASSET_COPY[asset.kind]
  const layout = LAYOUT[asset.kind]
  // Optimistic state so the grid reacts before main answers.
  const [order, setOrder] = useState<string[]>()
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set())
  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const [dragId, setDragId] = useState<string>()
  const [target, setTarget] = useState<DropTarget>()
  const [previewId, setPreviewId] = useState<string>()
  const dragRef = useRef<string | undefined>(undefined)
  const reorderSeq = useRef(0)

  const images = useMemo(() => {
    const visible = asset.images.filter((img) => !removing.has(img.id))
    if (!order) return visible
    const rank = new Map(order.map((id, i) => [id, i]))
    return visible.slice().sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length))
  }, [asset.images, removing, order])

  const ids = images.map((img) => img.id)
  const flagged = images.filter((img) => sizes[img.id] && imageIssues(sizes[img.id]).length > 0).length
  const dropAt = insertIndex(ids, dragId, target)

  const recordSize = useCallback(
    (id: string, size: Size) =>
      setSizes((s) => (s[id]?.width === size.width && s[id]?.height === size.height ? s : { ...s, [id]: size })),
    []
  )

  const reorder = async (next: string[]) => {
    const seq = ++reorderSeq.current
    setOrder(next)
    try {
      onUpdated(await window.studio.reorderAssetImages(asset.id, next))
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      // A newer reorder owns the optimistic order until it settles.
      if (seq === reorderSeq.current) setOrder(undefined)
    }
  }

  const makeCover = (id: string) => {
    if (ids[0] !== id) void reorder([id, ...ids.filter((x) => x !== id)])
  }

  // ⌥← / ⌥→ on a focused tile moves it one place (only the keys: the tiles keep their own drag and drop below).
  const keyMoves = useReorder({
    type: DRAG_TYPE,
    keys: ids,
    onMove: (from, to) => {
      const next = ids.filter((_, i) => i !== from)
      next.splice(to, 0, ids[from])
      void reorder(next)
    },
    describeMove: (_, to) =>
      to === 0 ? `The image is now the cover, first of ${ids.length}.` : `The image is now ${to + 1} of ${ids.length}.`
  })

  const remove = async (id: string) => {
    setRemoving((s) => new Set(s).add(id))
    try {
      onUpdated(await window.studio.removeAssetImage(id))
    } catch (e) {
      onError(ipcErrorMessage(e))
    } finally {
      setRemoving((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }

  const pick = async () => {
    try {
      const paths = await window.studio.pickImages(true)
      if (paths.length) onAdd(paths)
    } catch (e) {
      onError(ipcErrorMessage(e))
    }
  }

  // ── Reordering with HTML5 drag and drop ──

  const isInternal = (e: DragEvent) => !!dragRef.current && e.dataTransfer.types.includes(DRAG_TYPE)

  const startDrag = (e: DragEvent, id: string) => {
    e.dataTransfer.setData(DRAG_TYPE, id)
    e.dataTransfer.effectAllowed = 'move'
    dragRef.current = id
    // Dim the tile only after the browser has captured it as the drag image.
    requestAnimationFrame(() => {
      if (dragRef.current === id) setDragId(id)
    })
  }

  const endDrag = () => {
    dragRef.current = undefined
    setDragId(undefined)
    setTarget(undefined)
  }

  const overTile = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (!isInternal(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    setTarget((t) => (t?.id === id && t.after === after ? t : { id, after }))
  }

  const overGrid = (e: DragEvent) => {
    if (!isInternal(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const leaveGrid = (e: DragEvent<HTMLDivElement>) => {
    if (dragRef.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(undefined)
  }

  const dropOnGrid = (e: DragEvent) => {
    if (!isInternal(e)) return
    e.preventDefault()
    const dragged = dragRef.current!
    const to = insertIndex(ids, dragged, target)
    endDrag()
    if (to === undefined) return
    const next = ids.filter((id) => id !== dragged)
    next.splice(to, 0, dragged)
    void reorder(next)
  }

  const previewIndex = previewId ? ids.indexOf(previewId) : -1

  // One line under the title – how to reorder, which is the cover, and (products, poses) how the kind is used – with
  // how the images are sent as its tooltip.
  const reorderLine =
    images.length > 1
      ? `${reorderHint().replace(/^./, (c) => c.toUpperCase())} · the first is the cover`
      : images.length === 1
        ? 'The first is the cover'
        : undefined
  const hint = [reorderLine, copy.usage].filter(Boolean).join(' · ')

  return (
    <div>
      <SectionTitle
        title={copy.images?.title ?? 'Reference images'}
        hint={hint || undefined}
        hintTitle={images.length ? (copy.images?.intro ?? IMAGES_DETAIL) : undefined}
        actions={
          flagged > 0 && (
            <span
              className="text-[11px] text-warning"
              title="Venice rejects images under 300 px on the shortest side or with an aspect ratio outside 0.4–2.5."
            >
              ⚠ {flagged === 1 ? '1 image' : `${flagged} images`} may be rejected by Venice
            </span>
          )
        }
      />

      {images.length === 0 && adding === 0 ? (
        <button
          type="button"
          onClick={pick}
          className={`flex h-56 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed transition ${
            fileOver ? 'border-accent bg-accent/5 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
          }`}
        >
          <PlusIcon size={22} />
          <span className="text-sm">{fileOver ? 'Drop to add' : 'Drop images here or click to choose'}</span>
          <span className="max-w-sm text-[11px] leading-relaxed text-muted">
            JPG, PNG or WebP, at least 300 px on the shortest side. {copy.imageTips}
          </span>
        </button>
      ) : (
        <div
          onDragOver={overGrid}
          onDragLeave={leaveGrid}
          onDrop={dropOnGrid}
          className={`-m-2 rounded-lg border border-dashed p-2 transition ${
            fileOver ? 'border-accent bg-accent/5' : 'border-transparent'
          }`}
        >
          <div className={`grid ${layout.grid} gap-3`}>
            {images.map((image, i) => (
              <ImageTile
                key={image.id}
                image={image}
                index={i}
                keyMoves={keyMoves.itemProps(i)}
                aspect={layout.tile}
                size={sizes[image.id]}
                dragging={dragId === image.id}
                indicator={
                  dropAt === undefined || target?.id !== image.id ? undefined : target.after ? 'after' : 'before'
                }
                onSize={recordSize}
                onOpen={() => setPreviewId(image.id)}
                onRemove={() => void remove(image.id)}
                onMakeCover={() => makeCover(image.id)}
                onDragStart={(e) => startDrag(e, image.id)}
                onDragOver={(e) => overTile(e, image.id)}
                onDragEnd={endDrag}
              />
            ))}
            {Array.from({ length: adding }, (_, i) => (
              <div key={`adding-${i}`} className={`${layout.tile} animate-pulse rounded-md bg-raised`} />
            ))}
            <button
              type="button"
              onClick={pick}
              className={`flex ${layout.tile} flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line text-muted transition hover:border-muted hover:text-text`}
            >
              <PlusIcon size={18} />
              <span>Add</span>
            </button>
          </div>
          <span aria-live="polite" className="sr-only">
            {keyMoves.announcement}
          </span>
        </div>
      )}

      {images.length > MAX_REFERENCES && (
        <p className="mt-3 text-[11px] text-muted">
          {copy.images?.many ?? (
            <>
              Venice takes at most {MAX_REFERENCES} reference images per generation, in total. When you generate{' '}
              {copy.generatePhrase}, the first ones come along, as many as fit.
            </>
          )}
        </p>
      )}

      {previewId && previewIndex !== -1 && (
        <ImagePreview
          images={images}
          index={previewIndex}
          size={sizes[previewId]}
          onSize={recordSize}
          onIndex={(i) => setPreviewId(ids[i])}
          onClose={() => setPreviewId(undefined)}
          onMakeCover={() => makeCover(previewId)}
          onRemove={() => {
            setPreviewId(ids[previewIndex + 1] ?? ids[previewIndex - 1])
            void remove(previewId)
          }}
        />
      )}
    </div>
  )
}

interface TileProps {
  image: AssetImage
  index: number
  /** ⌥← / ⌥→: its place on screen and the keys (useReorder's item props, of which the tile takes these two). */
  keyMoves: HTMLAttributes<HTMLElement> & { ref: Ref<HTMLElement> }
  /** Tailwind aspect-ratio class of the tile. */
  aspect: string
  size?: Size
  dragging: boolean
  /** Side on which the drop marker is drawn. */
  indicator?: 'before' | 'after'
  onSize: (id: string, size: Size) => void
  onOpen: () => void
  onRemove: () => void
  onMakeCover: () => void
  onDragStart: (e: DragEvent<HTMLDivElement>) => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

function ImageTile({
  image,
  index,
  keyMoves,
  aspect,
  size,
  dragging,
  indicator,
  onSize,
  onOpen,
  onRemove,
  onMakeCover,
  onDragStart,
  onDragOver,
  onDragEnd
}: TileProps) {
  const [broken, setBroken] = useState(false)
  const issues = size ? imageIssues(size) : []
  // Who added it, when an agent did, then what Venice might refuse about it.
  const tooltip = [originText(image.origin), ...issues.map((i) => i.detail)].filter(Boolean).join('\n')

  return (
    <div className="relative" onDragOver={onDragOver}>
      {indicator && (
        <div
          className={`pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-accent ${
            indicator === 'before' ? '-left-[7px]' : '-right-[7px]'
          }`}
        />
      )}
      <div
        ref={keyMoves.ref as Ref<HTMLDivElement>}
        role="button"
        tabIndex={0}
        aria-label={`Image ${index + 1}${index === 0 ? ', the cover' : ''}`}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        onKeyDown={(e) => {
          keyMoves.onKeyDown?.(e)
          if (e.defaultPrevented) return
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            onOpen()
          }
        }}
        title={tooltip || undefined}
        className={`group relative ${aspect} cursor-pointer overflow-hidden rounded-md border bg-raised outline-none transition focus-visible:border-muted focus-visible:ring-1 focus-visible:ring-muted ${
          issues.length ? 'border-amber-400/50' : 'border-line'
        } ${dragging ? 'opacity-30' : ''}`}
      >
        {broken ? (
          <div className="flex h-full items-center justify-center p-3 text-center text-[11px] text-muted">
            Couldn't read the image
          </div>
        ) : (
          <img
            src={mediaUrl(image.path)}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={(e) =>
              onSize(image.id, { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
            }
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        )}

        <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
          {index === 0 && <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium">Cover</span>}
          {issues.map((issue) => (
            <span key={issue.label} className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-medium text-black">
              ⚠ {issue.label}
            </span>
          ))}
        </div>

        {/*
          Shown on hover, while the tile has the keyboard focus, and while it has the focus itself (opacity, not
          display: a hidden button would lose the focus Tab just gave it). Asked in place, over the top of the tile:
          a narrow tile has no room for the question, so it reads [Cancel] [Remove].
        */}
        <ConfirmButton
          confirmLabel="Remove"
          onConfirm={onRemove}
          title={REMOVE_IMAGE_TITLE}
          armedClassName="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-center gap-1 bg-black/85 p-1.5"
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white opacity-0 outline-none transition hover:bg-accent-fill focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-white/70 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <CloseIcon size={10} />
          <span className="sr-only">Remove image {index + 1}</span>
        </ConfirmButton>

        {index > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onMakeCover()
            }}
            className="absolute inset-x-0 bottom-0 bg-black/70 py-1.5 text-[11px] opacity-0 outline-none transition hover:bg-black/90 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/70 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            Make cover
          </button>
        )}
      </div>
    </div>
  )
}
