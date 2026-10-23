import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { Storyboard, StoryboardTransition } from '@shared/types'
import { focusedWithKeyboard } from '../../lib/focusOrigin'
import { formatUsd, mediaUrl } from '../../lib/media'
import { useSeenWhenVisible } from '../../lib/work'
import { useClipQuote } from '../sequences/useTotalQuote'
import { PlayIcon, PlusIcon } from '../sequences/icons'
import type { SegmentNews } from '../takes/takeText'
import { buttonClass } from '../ui/button'
import { Spinner } from '../work/StatusMark'
import {
  boardNumber,
  durationLabel,
  excerpt,
  generateBlocked,
  transitionLabel,
  transitionStatus,
  type TransitionStatus
} from './storyboardUtils'

/** Width of the gap between two boards that the connector fills. */
export const CONNECTOR_WIDTH = 212

interface Props {
  storyboard: Storyboard
  /** Undefined for a moment after a board moved, until main has made the transitions for the new order. */
  transition?: StoryboardTransition
  /** Height of the board pictures beside it: the connector's line runs through their middle. */
  height: number
  /** Space above the pictures (the cards' top line). */
  offsetTop: number
  /** Its editor is open. */
  selected: boolean
  /** A take of it is being sent to Venice from here, the editor or an agent. */
  submitting: boolean
  /** Its takes that finished (or failed) and haven't been looked at yet. */
  news?: SegmentNews
  /** A dragged board would land here. */
  dropHere: boolean
  /** Insert a board between the two. */
  adding: boolean
  onOpen: () => void
  onGenerate: () => void
  onInsert: () => void
  /** ← / → on the card: the focus goes to the board before or after it. */
  onArrow?: (dir: -1 | 1) => void
}

/**
 * The clip between two boards, as a compact card on an arrow from one picture to the next: what happens (the
 * prompt's start), its state – the take in use, its progress, or what it waits for – its length and price, and
 * Generate when it has nothing yet and can be sent. A click (Enter, Space) opens it in the editor beside the boards;
 * ← / → go on along the row; the + above it, shown on hover, inserts a board between the two.
 */
export default function TransitionConnector({
  storyboard,
  transition: t,
  height,
  offsetTop,
  selected,
  submitting,
  news,
  dropHere,
  adding,
  onOpen,
  onGenerate,
  onInsert,
  onArrow
}: Props) {
  const status = t ? transitionStatus(t) : undefined
  const fromNumber = t ? boardNumber(storyboard, t.fromBoardId) : 0
  const toNumber = t ? boardNumber(storyboard, t.toBoardId) : 0
  const blocked = t ? generateBlocked(storyboard, t) : undefined
  // Only priced where it can be generated, so a row of empty boards doesn't ask Venice for prices.
  const quote = useClipQuote(t && !blocked ? t.params : undefined)
  // Generate where there is nothing usable yet, or the take in use was made from earlier pictures.
  const offerGenerate =
    !!status && (status.kind === 'empty' || status.kind === 'failed' || (status.kind === 'done' && status.stale))
  // A finished take nobody has looked at yet (chosen or not): "Done · new take" until it is played or clicked.
  const fresh = !!news?.fresh.length
  // A failure counts as seen once the card has been on screen a moment (D4); the card keeps saying it failed.
  const cardRef = useRef<HTMLDivElement>(null)
  useSeenWhenVisible(cardRef, news?.failed[0])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
    // Only on a card reached with the keyboard: on a clicked one Space plays the take (TransitionEditor).
    if ((e.key === 'Enter' || e.key === ' ') && focusedWithKeyboard(e.currentTarget)) onOpen()
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onArrow?.(e.key === 'ArrowLeft' ? -1 : 1)
    else return
    e.preventDefault()
  }

  return (
    <div
      className="group/gap relative flex shrink-0 items-center justify-center"
      style={{ width: CONNECTOR_WIDTH, height, marginTop: offsetTop }}
    >
      {/* The arrow from one picture to the next, behind the card. */}
      <span className="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-line" aria-hidden />
      <svg className="absolute right-0 top-1/2 -translate-y-1/2 text-line" width="8" height="10" viewBox="0 0 8 10" aria-hidden>
        <path
          d="M1 1l5 4-5 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {dropHere && <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent" aria-hidden />}

      <div className="relative">
        <button
          type="button"
          onClick={onInsert}
          disabled={adding}
          title="Add a board here – the transition between the boards is then replaced by two new ones"
          aria-label="Add a board here"
          // Shown on hover, as the + between two clips in Sequences; "New board" at the end is always there.
          className="absolute -top-9 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-bg text-muted opacity-0 transition hover:border-muted hover:text-text focus-visible:opacity-100 group-hover/gap:opacity-100 disabled:opacity-0"
        >
          <PlusIcon size={11} />
        </button>

        {t && status ? (
          <div
            ref={cardRef}
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={onKeyDown}
            aria-pressed={selected}
            aria-label={`${transitionLabel(storyboard, t)}, the clip from board ${fromNumber} to board ${toNumber}`}
            className={`flex w-[176px] cursor-pointer flex-col gap-2 rounded-lg border bg-panel p-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-muted ${
              selected ? 'border-accent/70 shadow-lg shadow-black/40' : 'border-line hover:border-muted/60'
            }`}
          >
            <div className="flex items-center gap-2">
              {/* A picture only when there is one to show: the take in use, or the one being made. */}
              {(status.kind === 'done' || status.kind === 'generating') && <StatusThumb status={status} />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-muted">
                  {transitionLabel(storyboard, t)}
                </p>
                <StatusLine status={status} fresh={fresh} />
              </div>
            </div>

            <p className={`line-clamp-2 min-h-[2lh] text-[11px] leading-snug ${t.params.prompt.trim() ? 'text-text/85' : 'italic text-muted'}`}>
              {t.params.prompt.trim() ? excerpt(t.params.prompt, 120) : 'What happens? Click to write.'}
            </p>

            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className="truncate tabular-nums">
                {durationLabel(t.params.duration)}
                {offerGenerate && !blocked && <> · {formatUsd(quote)}</>}
              </span>
              {/* Only when it can be sent (or is being sent): otherwise a click here opens the editor, which says why. */}
              {offerGenerate && (!blocked || submitting) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onGenerate()
                  }}
                  disabled={!!blocked || submitting}
                  title={blocked ?? `Generate a take of the clip (${formatUsd(quote)})`}
                  className={`${buttonClass('primary', 'inline')} ml-auto`}
                >
                  {submitting ? 'Sending…' : 'Generate'}
                </button>
              )}
            </div>
            {/* What stands in the way, unless the card already says it (no pictures yet, no prompt yet). */}
            {offerGenerate && blocked && t.params.prompt.trim() && (
              <p className="-mt-1 text-[10px] leading-snug text-warning">{blocked}</p>
            )}
          </div>
        ) : (
          <div className="flex h-24 w-[176px] items-center justify-center rounded-lg border border-dashed border-line text-[11px] text-muted">
            <span className="animate-pulse">Updating…</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** The take in use (with ▶) or the one being made (its progress), as a small picture beside the label. */
function StatusThumb({ status }: { status: Extract<TransitionStatus, { kind: 'done' | 'generating' }> }) {
  let content: ReactNode
  if (status.kind === 'done') {
    content = (
      <>
        {status.take.thumbPath ? (
          <img src={mediaUrl(status.take.thumbPath)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <span className="h-full w-full bg-raised" />
        )}
        <span className="absolute inset-0 flex items-center justify-center text-white/90">
          <PlayIcon size={10} />
        </span>
      </>
    )
  } else {
    content = (
      <span className="flex h-full w-full items-end bg-raised p-1">
        <span className="h-1 w-full overflow-hidden rounded-full bg-line">
          <span
            className="block h-full rounded-full bg-accent transition-all duration-1000"
            style={{ width: `${(status.progress ?? 0.04) * 100}%` }}
          />
        </span>
      </span>
    )
  }
  return <span className="relative flex h-[30px] w-[54px] shrink-0 overflow-hidden rounded bg-black">{content}</span>
}

function StatusLine({ status, fresh }: { status: TransitionStatus; fresh: boolean }) {
  if (fresh && status.kind !== 'generating') {
    return (
      <p
        className="truncate text-[11px] font-medium text-success"
        title="A new take is ready. Open the transition and click the take to watch it."
      >
        {status.kind === 'done' ? 'Done · new take' : 'New take'}
      </p>
    )
  }
  switch (status.kind) {
    case 'done':
      return status.stale ? (
        <p className="truncate text-[11px] text-warning" title="The selected take was made with an earlier image on one of the boards">
          Earlier image
        </p>
      ) : (
        <p className="truncate text-[11px] text-success">Done</p>
      )
    case 'generating':
      return (
        <p className="flex items-center gap-1 truncate text-[11px] text-text">
          <Spinner size={10} />
          {status.take.status === 'queued'
            ? 'Queued…'
            : `Generating${status.progress ? ` ${Math.round(status.progress * 100)}%` : '…'}`}
        </p>
      )
    case 'failed':
      return (
        <p className="truncate text-[11px] text-danger" title={status.take.error}>
          Failed
        </p>
      )
    case 'waiting':
      return <p className="truncate text-[11px] text-muted">Needs images</p>
    default:
      return <p className="truncate text-[11px] text-muted">Not generated</p>
  }
}
