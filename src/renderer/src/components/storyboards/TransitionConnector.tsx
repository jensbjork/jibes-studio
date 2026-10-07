import type { KeyboardEvent, ReactNode } from 'react'
import type { Storyboard, StoryboardTransition } from '@shared/types'
import { formatUsd, mediaUrl } from '../../lib/media'
import { useClipQuote } from '../sequences/useTotalQuote'
import { PlayIcon, PlusIcon } from '../sequences/icons'
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
  /** A take of it is being sent to Venice from here or the editor. */
  submitting: boolean
  /** A dragged board would land here. */
  dropHere: boolean
  /** Insert a board between the two. */
  adding: boolean
  onOpen: () => void
  onGenerate: () => void
  onInsert: () => void
}

/**
 * The clip between two boards, as a compact card on an arrow from one picture to the next: what happens (the
 * prompt's start), its state – the take in use, its progress, or what it waits for – its length and price, and
 * Generera when it has nothing yet. A click opens it in the editor beside the boards; the + above it inserts a
 * board between the two.
 */
export default function TransitionConnector({
  storyboard,
  transition: t,
  height,
  offsetTop,
  selected,
  submitting,
  dropHere,
  adding,
  onOpen,
  onGenerate,
  onInsert
}: Props) {
  const status = t ? transitionStatus(t) : undefined
  const fromNumber = t ? boardNumber(storyboard, t.fromBoardId) : 0
  const toNumber = t ? boardNumber(storyboard, t.toBoardId) : 0
  const blocked = t ? generateBlocked(storyboard, t) : undefined
  // Only priced where it can be generated, so a row of empty boards doesn't ask Venice for prices.
  const quote = useClipQuote(t && !blocked ? t.params : undefined)
  // Generera where there is nothing usable yet, or the take in use was made from earlier pictures.
  const offerGenerate =
    !!status && (status.kind === 'empty' || status.kind === 'failed' || (status.kind === 'done' && status.stale))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    onOpen()
  }

  return (
    <div className="relative flex shrink-0 items-center justify-center" style={{ width: CONNECTOR_WIDTH, height, marginTop: offsetTop }}>
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
          title="Lägg till en ruta här – övergången mellan rutorna ersätts då av två nya"
          aria-label="Lägg till en ruta här"
          className="absolute -top-9 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-bg text-muted opacity-50 transition hover:border-muted hover:text-text hover:opacity-100 focus-visible:opacity-100 disabled:opacity-20"
        >
          <PlusIcon size={11} />
        </button>

        {t && status ? (
          <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={onKeyDown}
            aria-pressed={selected}
            aria-label={`${transitionLabel(storyboard, t)}, klippet från ruta ${fromNumber} till ruta ${toNumber}`}
            className={`flex w-[176px] cursor-pointer flex-col gap-2 rounded-lg border bg-panel p-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-muted ${
              selected ? 'border-accent/70 shadow-lg shadow-black/40' : 'border-line hover:border-muted/60'
            }`}
          >
            <div className="flex items-center gap-2">
              <StatusThumb status={status} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-muted">
                  {transitionLabel(storyboard, t)}
                </p>
                <StatusLine status={status} />
              </div>
            </div>

            <p className={`line-clamp-2 min-h-[2lh] text-[11px] leading-snug ${t.params.prompt.trim() ? 'text-text/85' : 'italic text-muted/70'}`}>
              {t.params.prompt.trim() ? excerpt(t.params.prompt, 120) : 'Vad händer? Klicka för att skriva.'}
            </p>

            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className="truncate tabular-nums">
                {durationLabel(t.params.duration)}
                {offerGenerate && !blocked && <> · {formatUsd(quote)}</>}
              </span>
              {offerGenerate && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onGenerate()
                  }}
                  disabled={!!blocked || submitting}
                  title={blocked ?? `Generera klippet (${formatUsd(quote)})`}
                  className="ml-auto rounded-md bg-accent px-2 py-0.5 font-medium text-white transition hover:bg-accent-hover disabled:bg-raised disabled:text-muted"
                >
                  {submitting ? 'Skickar…' : status.kind === 'empty' ? 'Generera' : 'Igen'}
                </button>
              )}
            </div>
            {/* What stands in the way, unless the card already says it (no pictures yet, no prompt yet). */}
            {offerGenerate && blocked && t.params.prompt.trim() && (
              <p className="-mt-1 text-[10px] leading-snug text-amber-300/90">{blocked}</p>
            )}
          </div>
        ) : (
          <div className="flex h-24 w-[176px] items-center justify-center rounded-lg border border-dashed border-line text-[11px] text-muted">
            <span className="animate-pulse">Uppdaterar…</span>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusThumb({ status }: { status: TransitionStatus }) {
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
  } else if (status.kind === 'generating') {
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
  } else {
    content = <span className="h-full w-full bg-raised" />
  }
  return <span className="relative flex h-[30px] w-[54px] shrink-0 overflow-hidden rounded bg-black">{content}</span>
}

function StatusLine({ status }: { status: TransitionStatus }) {
  switch (status.kind) {
    case 'done':
      return status.stale ? (
        <p className="truncate text-[11px] text-amber-300" title="Klippet gjordes med en tidigare bild i någon av rutorna">
          Tidigare bild
        </p>
      ) : (
        <p className="truncate text-[11px] text-emerald-300/90">Klart</p>
      )
    case 'generating':
      return (
        <p className="truncate text-[11px] text-text">
          {status.take.status === 'queued'
            ? 'I kö…'
            : `Genererar${status.progress ? ` ${Math.round(status.progress * 100)} %` : '…'}`}
        </p>
      )
    case 'failed':
      return (
        <p className="truncate text-[11px] text-accent" title={status.take.error}>
          Misslyckades
        </p>
      )
    case 'waiting':
      return <p className="truncate text-[11px] text-muted">Väntar på bilder</p>
    default:
      return <p className="truncate text-[11px] text-muted">Inte genererat</p>
  }
}
