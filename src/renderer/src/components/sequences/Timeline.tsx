import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { Segment, Sequence } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { BridgeIcon, LinkIcon, PlusIcon } from './icons'
import {
  bridgeDescription,
  clipLength,
  continuationMismatch,
  endMismatch,
  formatLength,
  pendingTake,
  readyTake,
  selectedTake,
  takeProgress
} from './sequenceUtils'

/** Drag payload of a clip being reordered (its id). */
const SEGMENT_DRAG_TYPE = 'application/x-studio-segment'

interface Props {
  sequence: Sequence
  selectedId?: string
  adding: boolean
  onSelect: (segmentId: string) => void
  /** Adds a segment after the given one, or at the end. */
  onAdd: (afterSegmentId?: string) => void
  onMove: (segmentId: string, toIndex: number) => void
  /** "Gör om mellan grannarna" on a card. */
  onBridge: (segmentId: string) => void
}

/** Horizontal strip of clips in cut order: select, insert, and reorder by drag and drop. */
export default function Timeline({ sequence, selectedId, adding, onSelect, onAdd, onMove, onBridge }: Props) {
  const segments = sequence.segments
  const cards = useRef(new Map<string, HTMLDivElement>())
  const [dragId, setDragId] = useState<string>()
  // Gap g sits before segment g (g = segments.length is after the last one).
  const [dropGap, setDropGap] = useState<number>()

  useEffect(() => {
    if (selectedId) cards.current.get(selectedId)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  const dragFrom = dragId ? segments.findIndex((s) => s.id === dragId) : -1

  const gapAt = (clientX: number): number => {
    let gap = 0
    segments.forEach((s, i) => {
      const r = cards.current.get(s.id)?.getBoundingClientRect()
      if (r && clientX > r.left + r.width / 2) gap = i + 1
    })
    return gap
  }

  const onDragOver = (e: DragEvent) => {
    if (dragFrom === -1) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const gap = gapAt(e.clientX)
    // Dropping right before or after itself changes nothing, so don't suggest it.
    setDropGap(gap === dragFrom || gap === dragFrom + 1 ? undefined : gap)
  }

  const onDrop = (e: DragEvent) => {
    if (dragFrom === -1 || !dragId) return
    e.preventDefault()
    const gap = gapAt(e.clientX)
    const to = gap > dragFrom ? gap - 1 : gap
    if (to !== dragFrom) onMove(dragId, to)
    setDragId(undefined)
    setDropGap(undefined)
  }

  const focusCard = (i: number) => {
    const s = segments[i]
    if (!s) return
    onSelect(s.id)
    cards.current.get(s.id)?.focus()
  }

  const cardKeys = (e: KeyboardEvent, i: number) => {
    if (e.key === 'ArrowRight') focusCard(i + 1)
    else if (e.key === 'ArrowLeft') focusCard(i - 1)
    else if (e.key === 'Enter' || e.key === ' ') onSelect(segments[i].id)
    else return
    e.preventDefault()
  }

  if (!segments.length) {
    return (
      <div className="shrink-0 border-b border-line p-4">
        <button
          onClick={() => onAdd()}
          disabled={adding}
          className="flex h-[143px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line text-muted transition hover:border-muted hover:text-text disabled:opacity-40"
        >
          <PlusIcon size={18} />
          <span>Lägg till första klippet</span>
        </button>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-b border-line">
      <div
        className="overflow-x-auto"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropGap(undefined)
        }}
      >
        <div className="flex w-max items-stretch px-3 py-3">
          <EdgeGap active={dropGap === 0} />
          {segments.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && (
                <Joint
                  segment={s}
                  previous={segments[i - 1]}
                  number={i + 1}
                  dropHere={dropGap === i}
                  adding={adding}
                  onInsert={() => onAdd(segments[i - 1].id)}
                />
              )}
              <SegmentCard
                segment={s}
                number={i + 1}
                bridgeTitle={bridgeDescription(i, segments.length)}
                onBridge={() => onBridge(s.id)}
                selected={s.id === selectedId}
                dragging={s.id === dragId}
                refCallback={(el) => {
                  if (el) cards.current.set(s.id, el)
                  else cards.current.delete(s.id)
                }}
                onSelect={() => onSelect(s.id)}
                onKeyDown={(e) => cardKeys(e, i)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  // A private type, so dropping a card on a text field doesn't paste anything.
                  e.dataTransfer.setData(SEGMENT_DRAG_TYPE, s.id)
                  setDragId(s.id)
                }}
                onDragEnd={() => {
                  setDragId(undefined)
                  setDropGap(undefined)
                }}
              />
            </Fragment>
          ))}
          <EdgeGap active={dropGap === segments.length} />
          <button
            onClick={() => onAdd()}
            disabled={adding}
            title="Lägg till ett klipp sist"
            className="ml-1 flex w-28 shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-[12px] text-muted transition hover:border-muted hover:text-text disabled:opacity-40"
          >
            <PlusIcon size={16} />
            Lägg till klipp
          </button>
        </div>
      </div>
    </div>
  )
}

function EdgeGap({ active }: { active: boolean }) {
  return (
    <div className="relative w-2 shrink-0">
      {active && <span className="pointer-events-none absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent" />}
    </div>
  )
}

/** The space between two cards: continuation link, insert button and drop indicator. */
function Joint({
  segment,
  previous,
  number,
  dropHere,
  adding,
  onInsert
}: {
  segment: Segment
  previous: Segment
  number: number
  dropHere: boolean
  adding: boolean
  onInsert: () => void
}) {
  // The two clips share a frame: this one starts on the previous clip's last frame, or the previous one ends on
  // this one's first (a clip redone between its neighbours).
  const continues = segment.continueFromPrevious
  const endsHere = previous.endFromNext
  const linked = continues || endsHere
  const mismatch = continuationMismatch(segment, previous) || endMismatch(previous, segment)
  const description = [
    continues ? `Klipp ${number} fortsätter från sista bildrutan i klipp ${number - 1}.` : '',
    endsHere ? `Klipp ${number - 1} slutar på första bildrutan i klipp ${number}.` : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="group/joint relative flex w-10 shrink-0 flex-col items-center">
      <div className="relative flex h-[99px] w-full items-center justify-center">
        {linked && (
          <>
            <span className={`absolute inset-x-0 top-1/2 h-px ${mismatch ? 'bg-amber-500/50' : 'bg-muted/50'}`} />
            <span
              title={
                mismatch
                  ? `${description} Ingen av de valda tagningarna gjordes från den andras bildruta som den ser ut nu – generera en ny tagning för en sömlös övergång.`
                  : description
              }
              className={`relative flex h-6 w-6 items-center justify-center rounded-full border ${
                mismatch ? 'border-amber-500/60 bg-[#2a2113] text-amber-400' : 'border-line bg-raised text-text'
              }`}
            >
              <LinkIcon size={13} />
            </span>
          </>
        )}
      </div>
      <button
        onClick={onInsert}
        disabled={adding}
        title={`Infoga ett klipp mellan ${number - 1} och ${number}`}
        className="mt-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-raised text-muted opacity-0 transition hover:border-muted hover:text-text focus:opacity-100 group-hover/joint:opacity-100 disabled:opacity-0"
      >
        <PlusIcon size={11} />
      </button>
      {dropHere && (
        <span className="pointer-events-none absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent" />
      )}
    </div>
  )
}

function SegmentCard({
  segment,
  number,
  bridgeTitle,
  onBridge,
  selected,
  dragging,
  refCallback,
  onSelect,
  onKeyDown,
  onDragStart,
  onDragEnd
}: {
  segment: Segment
  number: number
  /** What "Gör om mellan grannarna" does here; undefined for a clip without neighbours. */
  bridgeTitle?: string
  onBridge: () => void
  selected: boolean
  dragging: boolean
  refCallback: (el: HTMLDivElement | null) => void
  onSelect: () => void
  onKeyDown: (e: KeyboardEvent) => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
}) {
  const takes = segment.takes.length
  const length = clipLength(segment)
  const trimmed = segment.trimStart > 0 || segment.trimEnd > 0
  const prompt = segment.params.prompt.trim()

  return (
    <div
      ref={refCallback}
      role="button"
      tabIndex={0}
      draggable
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title="Klicka för att redigera, dra för att flytta"
      className={`group/card w-44 shrink-0 cursor-pointer overflow-hidden rounded-lg border bg-panel outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
        selected ? 'border-accent ring-1 ring-accent/30' : 'border-line hover:border-muted/60'
      } ${dragging ? 'opacity-40' : ''}`}
    >
      <div className="relative aspect-video bg-black">
        <CardPreview segment={segment} />
        <span className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-px text-[11px] font-semibold tabular-nums">
          {number}
        </span>
        {takes > 0 && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/75 px-1.5 py-px text-[10px] text-muted">
            {takes} {takes === 1 ? 'tagning' : 'tagningar'}
          </span>
        )}
        {bridgeTitle && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onBridge()
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title={`Gör om mellan grannarna: ${bridgeTitle}`}
            aria-label="Gör om mellan grannarna"
            className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-text opacity-0 transition hover:bg-black focus:opacity-100 group-hover/card:opacity-100"
          >
            <BridgeIcon size={11} />
            Gör om
          </button>
        )}
      </div>
      <div className="px-2 py-1.5">
        <p className={`truncate text-[12px] ${prompt ? '' : 'italic text-muted'}`} title={prompt || undefined}>
          {prompt || 'Ingen prompt än'}
        </p>
        <p className="mt-0.5 flex justify-between text-[11px] text-muted">
          <span className="tabular-nums">
            {length !== undefined ? formatLength(length) : `≈ ${segment.params.duration.replace(/s$/, ' s')}`}
          </span>
          {trimmed && length !== undefined && <span>trimmad</span>}
        </p>
      </div>
    </div>
  )
}

function CardPreview({ segment }: { segment: Segment }) {
  const ready = readyTake(segment)
  const pending = pendingTake(segment)
  const selected = selectedTake(segment)
  const latest = segment.takes[0]

  if (ready) {
    return (
      <>
        {ready.thumbPath ? (
          <img src={mediaUrl(ready.thumbPath)} draggable={false} className="h-full w-full object-cover" />
        ) : (
          // No poster yet (older take or still being extracted); the browser can show a frame itself.
          <video
            src={`${mediaUrl(ready.filePath!)}#t=0.5`}
            preload="metadata"
            muted
            className="pointer-events-none h-full w-full object-cover"
          />
        )}
        {pending && (
          <span
            title="En ny tagning genereras"
            className="absolute bottom-1.5 right-1.5 h-2 w-2 animate-pulse rounded-full bg-accent ring-2 ring-black/60"
          />
        )}
      </>
    )
  }

  if (pending) {
    const progress = takeProgress(pending)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-[11px] text-muted">
        <span className="animate-pulse">{pending.status === 'queued' ? 'I kö…' : 'Genererar…'}</span>
        <div className="h-1 w-full overflow-hidden rounded bg-raised">
          <div className="h-full bg-accent transition-all duration-1000" style={{ width: `${(progress ?? 0.03) * 100}%` }} />
        </div>
      </div>
    )
  }

  if (selected?.fileMissing) {
    return <div className="flex h-full items-center justify-center text-[11px] text-muted">Filen saknas</div>
  }

  if (selected?.status === 'failed' || latest?.status === 'failed') {
    return <div className="flex h-full items-center justify-center text-[11px] text-accent">Misslyckades</div>
  }

  return (
    <div className="flex h-full items-center justify-center text-[11px] text-muted">
      {latest ? 'Ingen vald tagning' : 'Ingen tagning'}
    </div>
  )
}
