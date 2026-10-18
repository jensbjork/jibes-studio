import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { generationTitle, sourceBadge } from '@shared/generation-label'
import type { FinishedWork, RunningWork, Segment, Sequence } from '@shared/types'
import { mediaUrl } from '../../lib/media'
import { useSeenWhenVisible } from '../../lib/work'
import { carriesFiles, droppedVideoPaths, ImportCardView, type ImportCard } from '../feed/ownClips'
import Popover from '../pickers/Popover'
import { menuRow, onMenuKeyDown } from '../storyboards/ui'
import { freshTakesLabel, newsBySegment, pendingPhase, type SegmentNews } from '../takes/takeText'
import { NewChip, Spinner } from '../work/StatusMark'
import { BridgeIcon, CameraIcon, ChevronDownIcon, LinkIcon, PlusIcon } from './icons'
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

/** Where a clip that isn't an empty AI clip comes from: the user's own file, the clip feed, the Editor's versions. */
export type ClipSource = 'file' | 'feed' | 'edit'

interface Props {
  sequence: Sequence
  selectedId?: string
  adding: boolean
  onSelect: (segmentId: string) => void
  /** Adds an empty clip (to generate) after the given one, or at the end. */
  onAdd: (afterSegmentId?: string) => void
  /** "Own clip from file…", "From Media…", "From the Editor…": a clip from elsewhere, after the given one. */
  onAddFrom: (source: ClipSource, afterSegmentId?: string) => void
  /**
   * Video files dropped on the strip, to become own clips at gap `gap` (before clip `gap`, 0-based; the number of
   * clips is after the last one).
   */
  onDropFiles: (paths: string[], gap: number) => void
  /** Own clips on their way into this sequence (shown after the last clip with their progress). */
  importing: ImportCard[]
  /** What finished in this sequence that the user hasn't looked at yet (Activity). */
  unseen: FinishedWork[]
  /** What runs in this sequence now (takes being sent show on their cards). */
  running: RunningWork[]
  onMove: (segmentId: string, toIndex: number) => void
  /** "Redo between neighbours" on a card. */
  onBridge: (segmentId: string) => void
}

/** Horizontal strip of clips in cut order: select, insert, reorder by drag and drop, and drop own films onto. */
export default function Timeline({
  sequence,
  selectedId,
  adding,
  onSelect,
  onAdd,
  onAddFrom,
  onDropFiles,
  importing,
  unseen,
  running,
  onMove,
  onBridge
}: Props) {
  const segments = sequence.segments
  const news = useMemo(() => newsBySegment(unseen), [unseen])
  // A take on its way to Venice has no row yet: its card says so from the store.
  const sending = useMemo(
    () => new Set(running.flatMap((w) => (w.kind === 'sending' && w.segmentId ? [w.segmentId] : []))),
    [running]
  )
  const cards = useRef(new Map<string, HTMLDivElement>())
  const [dragId, setDragId] = useState<string>()
  // Gap g sits before segment g (g = segments.length is after the last one).
  const [dropGap, setDropGap] = useState<number>()
  // Files from Finder over the strip: where they would go.
  const [fileGap, setFileGap] = useState<number>()

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
    if (dragFrom === -1) {
      // Files from Finder: own films, inserted where they are dropped.
      if (!carriesFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setFileGap(gapAt(e.clientX))
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const gap = gapAt(e.clientX)
    // Dropping right before or after itself changes nothing, so don't suggest it.
    setDropGap(gap === dragFrom || gap === dragFrom + 1 ? undefined : gap)
  }

  const onDrop = (e: DragEvent) => {
    if (dragFrom === -1 || !dragId) {
      if (!carriesFiles(e)) return
      e.preventDefault()
      const gap = gapAt(e.clientX)
      setFileGap(undefined)
      const { paths } = droppedVideoPaths(e)
      if (paths.length) onDropFiles(paths, gap)
      return
    }
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
      <div
        className="relative shrink-0 border-b border-line p-4"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileGap(undefined)
        }}
      >
        {importing.length > 0 ? (
          <div className="flex h-[143px] gap-3">
            {importing.map((card) => (
              <div key={card.path} className="w-44 shrink-0 overflow-hidden rounded-lg border border-line bg-panel">
                <ImportCardView card={card} compact />
              </div>
            ))}
          </div>
        ) : (
          <div
            className={`flex h-[143px] w-full flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed transition ${
              fileGap !== undefined ? 'border-accent/70 bg-accent/10' : 'border-line'
            }`}
          >
            <button
              onClick={() => onAdd()}
              disabled={adding}
              className="flex flex-col items-center gap-2 rounded-md px-4 py-1.5 text-muted transition hover:text-text disabled:opacity-40"
            >
              <PlusIcon size={18} />
              <span>
                {fileGap !== undefined ? (
                  <span className="text-text">Drop to add as own clips</span>
                ) : (
                  <>
                    <span className="text-text">Add the first clip</span>
                    <span className="text-muted"> · or drop a film of your own here</span>
                  </>
                )}
              </span>
            </button>
            {fileGap === undefined && (
              <div className="flex items-center gap-1 text-[12px] text-muted">
                <SourceLink onClick={() => onAddFrom('file')}>Own clip from file…</SourceLink>
                <span aria-hidden>·</span>
                <SourceLink onClick={() => onAddFrom('feed')}>From Media…</SourceLink>
                <span aria-hidden>·</span>
                <SourceLink onClick={() => onAddFrom('edit')}>From the Editor…</SourceLink>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const marker = dropGap ?? fileGap

  return (
    <div className="relative shrink-0 border-b border-line">
      {fileGap !== undefined && (
        <span className="pointer-events-none absolute right-4 top-1 z-10 rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white shadow">
          Drop to add as own clips
        </span>
      )}
      <div
        className="overflow-x-auto"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropGap(undefined)
            setFileGap(undefined)
          }
        }}
      >
        <div className="flex w-max items-stretch px-3 py-3">
          <EdgeGap active={marker === 0} />
          {segments.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && (
                <Joint
                  segment={s}
                  previous={segments[i - 1]}
                  number={i + 1}
                  dropHere={marker === i}
                  adding={adding}
                  onInsert={() => onAdd(segments[i - 1].id)}
                  onInsertFrom={(source) => onAddFrom(source, segments[i - 1].id)}
                />
              )}
              <SegmentCard
                segment={s}
                number={i + 1}
                news={news.get(s.id)}
                sending={sending.has(s.id)}
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
          <EdgeGap active={marker === segments.length} />
          {importing.map((card) => (
            <div
              key={card.path}
              className="ml-1 w-44 shrink-0 overflow-hidden rounded-lg border border-line bg-panel"
              title={card.note}
            >
              <ImportCardView card={card} compact />
            </div>
          ))}
          <AddSplitButton adding={adding} onAdd={() => onAdd()} onAddFrom={(source) => onAddFrom(source)} />
        </div>
      </div>
    </div>
  )
}

function SourceLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-1.5 py-0.5 underline-offset-2 transition hover:bg-raised hover:text-text"
    >
      {children}
    </button>
  )
}

/** "Add clip ▾": the button adds an empty clip to generate; the ▾ part offers the other sources. */
function AddSplitButton({
  adding,
  onAdd,
  onAddFrom
}: {
  adding: boolean
  onAdd: () => void
  onAddFrom: (source: ClipSource) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <div className="ml-1 flex w-28 shrink-0 flex-col overflow-hidden rounded-lg border border-dashed border-line text-[12px] text-muted">
      <button
        onClick={onAdd}
        disabled={adding}
        title="Add a clip to generate, at the end"
        className="flex flex-1 flex-col items-center justify-center gap-1.5 transition hover:bg-raised/60 hover:text-text disabled:opacity-40"
      >
        <PlusIcon size={16} />
        Add clip
      </button>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={adding}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Own clip, from Media or from the Editor"
        className={`flex h-7 shrink-0 items-center justify-center gap-1 border-t border-dashed border-line transition hover:bg-raised/60 hover:text-text disabled:opacity-40 ${
          open ? 'bg-raised/60 text-text' : ''
        }`}
      >
        More ways
        <ChevronDownIcon size={11} />
      </button>
      <AddMenu
        anchorRef={anchor}
        open={open}
        onClose={() => setOpen(false)}
        onPick={(source) => {
          setOpen(false)
          onAddFrom(source)
        }}
      />
    </div>
  )
}

/** The ways to add a clip besides an empty one: the user's own file, the clip feed, a version from the Editor. */
function AddMenu({
  anchorRef,
  open,
  onClose,
  onPick,
  onEmpty
}: {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  onPick: (source: ClipSource) => void
  /** Also offers an empty clip to generate (the + between two clips). */
  onEmpty?: () => void
}) {
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} align="start" width={270} label="Add clip">
      <div role="menu" aria-label="Add clip" onKeyDown={onMenuKeyDown} className="p-1">
        {onEmpty && (
          <button
            type="button"
            role="menuitem"
            data-menu-item
            autoFocus
            onClick={onEmpty}
            className={`${menuRow} flex-col items-start gap-0.5`}
          >
            <span>New clip to generate</span>
            <span className="text-[11px] leading-snug text-muted">
              An empty clip with the previous clip's settings.
            </span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          data-menu-item
          autoFocus={!onEmpty}
          onClick={() => onPick('file')}
          className={`${menuRow} flex-col items-start gap-0.5`}
        >
          <span>Own clip from file…</span>
          <span className="text-[11px] leading-snug text-muted">A film you shot or made yourself.</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-menu-item
          onClick={() => onPick('feed')}
          className={`${menuRow} flex-col items-start gap-0.5`}
        >
          <span>From Media…</span>
          <span className="text-[11px] leading-snug text-muted">A clip you already have in Media.</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-menu-item
          onClick={() => onPick('edit')}
          className={`${menuRow} flex-col items-start gap-0.5`}
        >
          <span>From the Editor…</span>
          <span className="text-[11px] leading-snug text-muted">A version of a film you've changed in the Editor.</span>
        </button>
      </div>
    </Popover>
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
  onInsert,
  onInsertFrom
}: {
  segment: Segment
  previous: Segment
  number: number
  dropHere: boolean
  adding: boolean
  onInsert: () => void
  onInsertFrom: (source: ClipSource) => void
}) {
  const plus = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The two clips share a frame: this one starts on the previous clip's last frame, or the previous one ends on
  // this one's first (a clip redone between its neighbours).
  const continues = segment.continueFromPrevious
  const endsHere = previous.endFromNext
  const linked = continues || endsHere
  const mismatch = continuationMismatch(segment, previous) || endMismatch(previous, segment)
  const description = [
    continues ? `Clip ${number} continues from the last frame of clip ${number - 1}.` : '',
    endsHere ? `Clip ${number - 1} ends on the first frame of clip ${number}.` : ''
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
                  ? `${description} Neither selected take was made from the other's frame as it is now – generate a new take for a seamless transition.`
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
        ref={plus}
        onClick={() => setMenuOpen((o) => !o)}
        disabled={adding}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={`Insert a clip between ${number - 1} and ${number}`}
        className={`mt-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-raised text-muted transition hover:border-muted hover:text-text focus:opacity-100 group-hover/joint:opacity-100 disabled:opacity-0 ${
          menuOpen ? 'border-muted text-text opacity-100' : 'opacity-0'
        }`}
      >
        <PlusIcon size={11} />
      </button>
      <AddMenu
        anchorRef={plus}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onEmpty={() => {
          setMenuOpen(false)
          onInsert()
        }}
        onPick={(source) => {
          setMenuOpen(false)
          onInsertFrom(source)
        }}
      />
      {dropHere && (
        <span className="pointer-events-none absolute inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent" />
      )}
    </div>
  )
}

function SegmentCard({
  segment,
  number,
  news,
  sending,
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
  /** Its takes that finished (or failed) and haven't been looked at yet. */
  news?: SegmentNews
  /** A take of it is being sent to Venice. */
  sending: boolean
  /** What "Redo between neighbours" does here; undefined for a clip without neighbours. */
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
  // An own film (or a version from the Editor) as the clip's take: named by its title, marked "Own".
  const chosen = selectedTake(segment)
  const badge = chosen ? sourceBadge(chosen) : undefined
  const own = !!chosen && (badge?.kind === 'own' || badge?.kind === 'edited')
  const text = own ? generationTitle(chosen, 80) : prompt

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
      title="Click to edit, drag to move"
      className={`group/card w-44 shrink-0 cursor-pointer overflow-hidden rounded-lg border bg-panel outline-none transition focus-visible:ring-1 focus-visible:ring-muted ${
        selected ? 'border-accent ring-1 ring-accent/30' : 'border-line hover:border-muted/60'
      } ${dragging ? 'opacity-40' : ''}`}
    >
      <div className="relative aspect-video bg-black">
        <CardPreview segment={segment} sending={sending} />
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1">
          <span className="rounded bg-black/75 px-1.5 py-px text-[11px] font-semibold tabular-nums">{number}</span>
          {own && badge && (
            <span
              title={badge.description}
              className="flex items-center gap-1 rounded bg-black/75 px-1.5 py-px text-[10px] font-medium text-text"
            >
              <CameraIcon size={10} />
              {badge.label}
            </span>
          )}
        </span>
        <CardChip segment={segment} news={news} sending={sending} takes={takes} />
        {bridgeTitle && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onBridge()
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title={`Redo between neighbours: ${bridgeTitle}`}
            aria-label="Redo between neighbours"
            className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-text opacity-0 transition hover:bg-black focus:opacity-100 group-hover/card:opacity-100"
          >
            <BridgeIcon size={11} />
            Redo
          </button>
        )}
      </div>
      <div className="px-2 py-1.5">
        <p className={`truncate text-[12px] ${text ? '' : 'italic text-muted'}`} title={text || undefined}>
          {text || 'No prompt yet'}
        </p>
        <p className="mt-0.5 flex justify-between text-[11px] text-muted">
          <span className="tabular-nums">
            {length !== undefined ? formatLength(length) : `≈ ${segment.params.duration.replace(/s$/, ' s')}`}
          </span>
          {trimmed && length !== undefined && <span>trimmed</span>}
        </p>
      </div>
    </div>
  )
}

/**
 * The card's top-right chip, the most pressing first: a take being made (when the card shows a picture; else the
 * whole card says it), a new failure, new takes not looked at yet, else how many takes the clip has.
 */
function CardChip({
  segment,
  news,
  sending,
  takes
}: {
  segment: Segment
  news?: SegmentNews
  sending: boolean
  takes: number
}) {
  const chip = 'absolute right-1.5 top-1.5 flex items-center gap-1 rounded px-1.5 py-px text-[10px]'
  const pending = pendingTake(segment)
  const showsPicture = !!readyTake(segment)
  if ((pending || sending) && showsPicture) {
    return (
      <span className={`${chip} bg-black/75 text-text`} title="A new take is being generated">
        <Spinner size={10} />
        {pending ? pendingPhase(pending) : 'Sending'}
      </span>
    )
  }
  if (news?.failed.length) return <FailedChip className={chip} failedKey={news.failed[0]} />
  if (news?.fresh.length) {
    return (
      <NewChip
        variant="overlay"
        label={freshTakesLabel(news.fresh.length)}
        title="A new take is ready. Open the clip and click it to use it."
        className="absolute right-1.5 top-1.5"
      />
    )
  }
  if (!takes) return null
  return (
    <span className={`${chip} bg-black/75 text-muted`}>
      {takes} {takes === 1 ? 'take' : 'takes'}
    </span>
  )
}

/**
 * "Failed" on a clip's card: the failure counts as seen once it has been on screen a moment (D4), as on a
 * storyboard's transition card; the clip's take strip still says why.
 */
function FailedChip({ className, failedKey }: { className: string; failedKey: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useSeenWhenVisible(ref, failedKey)
  return (
    <span
      ref={ref}
      className={`${className} bg-black/75 font-medium text-accent`}
      title="A take failed. Open the clip to see why."
    >
      Failed
    </span>
  )
}

function CardPreview({ segment, sending }: { segment: Segment; sending: boolean }) {
  const ready = readyTake(segment)
  const pending = pendingTake(segment)
  const selected = selectedTake(segment)
  const latest = segment.takes[0]

  if (ready) {
    return ready.thumbPath ? (
      <img src={mediaUrl(ready.thumbPath)} alt="" draggable={false} className="h-full w-full object-cover" />
    ) : (
      // No poster yet (older take or still being extracted); the browser can show a frame itself.
      <video
        src={`${mediaUrl(ready.filePath!)}#t=0.5`}
        preload="metadata"
        muted
        className="pointer-events-none h-full w-full object-cover"
      />
    )
  }

  if (pending) {
    const progress = takeProgress(pending)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <Spinner size={11} />
          {pendingPhase(pending)}
        </span>
        <div className="h-1 w-full overflow-hidden rounded bg-raised">
          <div className="h-full bg-accent transition-all duration-1000" style={{ width: `${(progress ?? 0.03) * 100}%` }} />
        </div>
      </div>
    )
  }

  if (sending) {
    return (
      <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-muted">
        <Spinner size={11} />
        Sending to Venice
      </div>
    )
  }

  if (selected?.fileMissing) {
    return <div className="flex h-full items-center justify-center text-[11px] text-muted">File missing</div>
  }

  if (selected?.status === 'failed' || latest?.status === 'failed') {
    return <div className="flex h-full items-center justify-center text-[11px] text-accent">Failed</div>
  }

  return (
    <div className="flex h-full items-center justify-center text-[11px] text-muted">
      {latest ? 'No selected take' : 'No take'}
    </div>
  )
}
