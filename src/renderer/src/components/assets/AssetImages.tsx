import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import { DEFAULT_MODEL, maxReferenceImages } from '@shared/models'
import type { Asset, AssetImage, AssetKind } from '@shared/types'
import { ASSET_COPY, originText } from '../../lib/assets'
import { ipcErrorMessage } from '../../lib/hooks'
import { mediaUrl } from '../../lib/media'
import ImagePreview from './ImagePreview'
import { imageIssues, insertIndex, type DropTarget, type Size } from './imageUtils'

/** In-app drags carry this type, so they can't be mistaken for files dropped from Finder. */
const DRAG_TYPE = 'application/x-studio-asset-image'
const MAX_REFERENCES = maxReferenceImages(DEFAULT_MODEL['reference-to-video'])

// Places, and poses with people side by side, are mostly photographed wide; people and clothes upright; products
// as packshots, square.
const LAYOUT: Record<AssetKind, { grid: string; tile: string }> = {
  character: { grid: 'grid-cols-[repeat(auto-fill,minmax(140px,1fr))]', tile: 'aspect-[3/4]' },
  environment: { grid: 'grid-cols-[repeat(auto-fill,minmax(190px,1fr))]', tile: 'aspect-[4/3]' },
  product: { grid: 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]', tile: 'aspect-square' },
  outfit: { grid: 'grid-cols-[repeat(auto-fill,minmax(140px,1fr))]', tile: 'aspect-[3/4]' },
  pose: { grid: 'grid-cols-[repeat(auto-fill,minmax(190px,1fr))]', tile: 'aspect-[4/3]' }
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

/** Reference photo grid: add, remove, reorder (drag or "Sätt som omslag") and size warnings. */
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

  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-medium">Referensbilder</h2>
          {images.length > 0 && (
            <p className="mt-0.5 text-[11px] text-muted">
              {images.length > 1 ? 'Dra för att ändra ordning. ' : ''}Första bilden är omslaget. Bilderna följer med i
              den här ordningen när du genererar – sina @Image-nummer får de i Generera, efter bilderna som redan
              ligger där.
            </p>
          )}
        </div>
        {flagged > 0 && (
          <span
            className="shrink-0 text-[11px] text-amber-400"
            title="Venice nekar bilder med under 300 px på kortaste sidan eller ett sidförhållande utanför 0,4–2,5."
          >
            ⚠ {flagged === 1 ? '1 bild' : `${flagged} bilder`} kan nekas av Venice
          </span>
        )}
      </div>

      {images.length === 0 && adding === 0 ? (
        <button
          onClick={pick}
          className={`flex h-56 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed transition ${
            fileOver ? 'border-accent bg-accent/5 text-text' : 'border-line text-muted hover:border-muted hover:text-text'
          }`}
        >
          <span className="text-2xl">＋</span>
          <span className="text-sm">{fileOver ? 'Släpp för att lägga till' : 'Släpp bilder här eller klicka för att välja'}</span>
          <span className="max-w-sm text-[11px] leading-relaxed text-muted">
            JPG, PNG eller WebP, minst 300 px på kortaste sidan. {copy.imageTips}
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
              onClick={pick}
              className={`flex ${layout.tile} flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line text-muted transition hover:border-muted hover:text-text`}
            >
              <span className="text-xl">＋</span>
              <span>Lägg till</span>
            </button>
          </div>
        </div>
      )}

      {images.length > MAX_REFERENCES && (
        <p className="mt-3 text-[11px] text-muted">
          Venice tar emot högst {MAX_REFERENCES} referensbilder per generering, sammanlagt. När du genererar{' '}
          {copy.generatePhrase} följer de första med, så många som får plats.
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
        role="button"
        tabIndex={0}
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            onOpen()
          }
        }}
        title={tooltip || undefined}
        className={`group relative ${aspect} cursor-pointer overflow-hidden rounded-md border bg-raised outline-none transition focus-visible:border-muted ${
          issues.length ? 'border-amber-400/50' : 'border-line'
        } ${dragging ? 'opacity-30' : ''}`}
      >
        {broken ? (
          <div className="flex h-full items-center justify-center p-3 text-center text-[11px] text-muted">
            Bilden kunde inte läsas
          </div>
        ) : (
          <img
            src={mediaUrl(image.path)}
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
          {index === 0 && <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium">Omslag</span>}
          {issues.map((issue) => (
            <span key={issue.label} className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-medium text-black">
              ⚠ {issue.label}
            </span>
          ))}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="Ta bort bild"
          className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full bg-black/70 text-[11px] hover:bg-accent group-hover:flex group-focus-visible:flex"
        >
          ✕
        </button>

        {index > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onMakeCover()
            }}
            className="absolute inset-x-0 bottom-0 bg-black/70 py-1.5 text-[11px] opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 hover:bg-black/90"
          >
            Sätt som omslag
          </button>
        )}
      </div>
    </div>
  )
}
