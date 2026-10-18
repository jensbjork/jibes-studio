import { useState, type DragEvent, type ReactNode } from 'react'
import type { Still } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { formatStillTime, stillSourceLabel } from './imageModels'

/** Drag payload of a still: its id. Board image slots and the image dialog's references accept it. */
export const STILL_DRAG_TYPE = 'application/x-studio-still'

/** Whether a drag carries a still (only the types can be read before the drop). */
export function isStillDrag(e: Pick<DragEvent, 'dataTransfer'>): boolean {
  return Array.from(e.dataTransfer.types).includes(STILL_DRAG_TYPE)
}

/** The id of the still being dropped, if the drop is one. */
export function stillIdFromDrop(e: Pick<DragEvent, 'dataTransfer'>): string | undefined {
  return e.dataTransfer.getData(STILL_DRAG_TYPE) || undefined
}

interface Props {
  still: Still
  /** Click (or Enter) opens it, e.g. in the StillViewer. */
  onOpen?: (still: Still) => void
  /** Can be dragged onto a board or the image dialog's references (payload: STILL_DRAG_TYPE). */
  draggable?: boolean
  /** Marked as chosen, e.g. already among the references. */
  selected?: boolean
  /** Size and shape; default a 16:9 tile 96 px wide. */
  className?: string
  /** Shown in the corner, e.g. a delete button; stays clickable without opening the still. */
  children?: ReactNode
}

/** Thumbnail of a still (a generated image, an uploaded one or a frame saved from a clip). */
export default function StillThumb({
  still,
  onOpen,
  draggable = false,
  selected = false,
  className = 'aspect-video w-24',
  children
}: Props) {
  const [missing, setMissing] = useState(false)
  const excerpt = still.prompt.length > 160 ? `${still.prompt.slice(0, 157)}…` : still.prompt
  const title = `${stillSourceLabel(still)} · ${formatStillTime(still.createdAt)}${excerpt ? `\n${excerpt}` : ''}`

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(STILL_DRAG_TYPE, still.id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onClick={onOpen ? () => onOpen(still) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              onOpen(still)
            }
          : undefined
      }
      title={missing ? `File missing: ${still.path}` : title}
      className={`group relative shrink-0 overflow-hidden rounded-md bg-raised outline-none ring-offset-2 ring-offset-panel transition focus-visible:ring-2 focus-visible:ring-muted ${
        selected ? 'ring-2 ring-accent' : ''
      } ${onOpen ? 'cursor-pointer hover:brightness-110' : ''} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
    >
      {missing ? (
        <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] text-accent">
          File missing
        </span>
      ) : (
        <img
          src={mediaUrl(still.path)}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          onError={() => setMissing(true)}
          className="h-full w-full object-cover"
        />
      )}
      {still.source === 'frame' && (
        <span
          className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px] text-white/90"
          title="Frame from a clip"
        >
          Frame
        </span>
      )}
      {children && (
        <div
          className="absolute right-1 top-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export { StillThumb }
