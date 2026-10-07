import { useState, type DragEvent, type ReactNode, type Ref } from 'react'
import { mediaUrl } from '../lib/media'
import { moveItem } from './pickers/reorder'
import { occurrenceKeys, useReorder } from './pickers/useReorder'

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i

/** Drag payload of a reference image being moved within its strip (its key). */
export const REFERENCE_IMAGE_DRAG_TYPE = 'application/x-studio-reference-image'

/** A label on a thumbnail, e.g. the library asset the photo belongs to. */
export interface ImageCaption {
  text: string
  /** Tooltip; defaults to the text. */
  title?: string
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
  /** Whether several images can be put in another order by dragging them (multiple only). Default true. */
  reorderable?: boolean
}

/**
 * Drop zone + thumbnails for one or more local images. With several, the order is the @ImageN order: drag a
 * thumbnail to another place (or focus it and press ⌥← / ⌥→) and the numbers follow. Images past `max` stay
 * visible but are marked as not sent – moving one in front pushes the last one that was sent out.
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
  reorderable = true
}: Props) {
  const [over, setOver] = useState(false)
  // Remembered images can point at files that were deleted since (e.g. a removed character photo).
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  const keys = occurrenceKeys(value)

  const reorder = useReorder({
    type: REFERENCE_IMAGE_DRAG_TYPE,
    keys,
    onMove: multiple && reorderable ? (from, to) => onChange(moveItem(value, from, to)) : undefined,
    describeMove: (_, to) => {
      const sent = to < max
      return (
        `Bilden flyttades till plats ${to + 1} av ${value.length}` +
        (sent ? ` och heter nu @Image${to + 1}.` : ` och skickas inte – modellen tar max ${max} bilder.`)
      )
    }
  })

  // Several: added only into free places. A list already at (or past) the limit keeps every picture it has – the
  // ones marked "skickas inte" are kept on purpose (moved forward to be sent), never cut off by an addition.
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
    // Anything else (an audio chip, a still, text) can't be dropped here, nor files on a full strip, and the cursor
    // should say so.
    if (!carriesFiles(e) || !room) return
    e.preventDefault()
    setOver(true)
  }

  const onDrop = (e: DragEvent) => {
    if (reorder.onDrop(e)) return
    e.preventDefault()
    setOver(false)
    add(Array.from(e.dataTransfer.files).map((f) => window.studio.pathForFile(f)))
  }

  const pick = async () => add(await window.studio.pickImages(multiple))
  const full = value.length >= (multiple ? max : 1)
  const dragging = reorder.dragging !== -1
  const overflowCount = multiple ? Math.max(0, value.length - max) : 0

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-muted">{label}</span>
        <span className="flex items-center gap-2">
          {action}
          {multiple && showCount && (
            <span className={`text-[11px] ${value.length > max ? 'text-accent' : 'text-muted'}`}>
              {value.length}/{max}
            </span>
          )}
        </span>
      </div>
      <div
        role={multiple ? 'list' : undefined}
        aria-label={
          multiple
            ? `${label}${reorder.enabled ? ' – dra eller tryck ⌥← / ⌥→ för att ändra ordningen' : ''}`
            : undefined
        }
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          reorder.onDragLeave(e)
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={onDrop}
        className={`flex flex-wrap gap-2 rounded-md border border-dashed p-2 transition ${
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
          const name = p.split('/').pop()
          const isMissing = missing.has(p)
          const describe = overflow
            ? `Skickas inte – modellen tar max ${max} bilder`
            : isMissing
              ? `Filen saknas: ${p}`
              : cap
                ? `${cap.title ?? cap.text} · ${name}`
                : (name ?? p)
          const { ref, ...item } = reorder.itemProps(i)
          return (
            <div
              key={keys[i]}
              ref={ref as Ref<HTMLDivElement>}
              {...item}
              role={multiple ? 'listitem' : undefined}
              tabIndex={reorder.enabled ? 0 : undefined}
              aria-label={
                multiple
                  ? `${overflow ? 'Skickas inte' : `@Image${at + 1}`}: ${cap?.text ?? name ?? p}` +
                    (reorder.enabled ? '. Flytta med ⌥← och ⌥→.' : '')
                  : undefined
              }
              title={
                reorder.enabled && !dragging ? `${describe}\nDra för att ändra ordningen (eller ⌥← / ⌥→)` : describe
              }
              className={`group relative h-16 w-16 shrink-0 rounded bg-raised outline-none ring-offset-2 ring-offset-panel transition focus-visible:ring-2 focus-visible:ring-muted ${
                reorder.enabled ? 'cursor-grab active:cursor-grabbing' : ''
              } ${isMissing ? 'ring-1 ring-accent' : ''} ${reorder.dragging === i ? 'opacity-30' : ''}`}
            >
              <div className={`h-full w-full overflow-hidden rounded ${overflow ? 'opacity-40' : ''}`}>
                {isMissing ? (
                  <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
                    Filen saknas
                  </span>
                ) : (
                  <img
                    src={mediaUrl(p)}
                    draggable={false}
                    onError={() => setMissing((s) => new Set(s).add(p))}
                    className="pointer-events-none h-full w-full object-cover"
                  />
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
                  <span className="absolute left-1 top-1 rounded bg-black/80 px-1 text-[9px] leading-[14px] text-accent">
                    skickas inte
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
                title="Ta bort"
                aria-label={`Ta bort ${cap?.text ?? name ?? 'bilden'}`}
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
            onClick={pick}
            className="flex h-16 min-w-16 flex-1 items-center justify-center rounded text-muted hover:bg-raised hover:text-text"
          >
            {value.length ? '+' : 'Släpp bild här eller klicka'}
          </button>
        )}
      </div>
      {overflowCount > 0 && (
        <p className="mt-1 text-[11px] text-accent">
          {overflowCount === 1 ? 'Den sista bilden' : `De sista ${overflowCount} bilderna`} skickas inte – modellen tar
          max {max}.{reorder.enabled && ' Dra en bild längre fram för att skicka den i stället.'}
        </p>
      )}
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
      <span className="sr-only" aria-live="polite">
        {reorder.announcement}
      </span>
    </div>
  )
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
